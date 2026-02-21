use new_vdf_parser::appinfo_vdf_parser::open_appinfo_vdf;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;
use sysinfo::System;
use walkdir::WalkDir;

// ─── Data structures ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub game_count: usize,
    pub is_backup: bool,
    pub path: String,
    pub last_login: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwapSummary {
    pub source: Profile,
    pub targets: Vec<Profile>,
    pub source_last_modified: String,
    pub source_total_size: u64,
    pub source_file_count: usize,
    pub source_folder_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwapResult {
    pub success: bool,
    pub message: String,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppState {
    pub userdata_path: String,
    pub steam_path: String,
}

// ─── AppInfo cache ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct CachedGameEntry {
    name: String,
    executables: Vec<String>,
}

struct AppInfoCache {
    last_modified: Option<SystemTime>,
    games: HashMap<String, CachedGameEntry>,
}

static APP_INFO_CACHE: Mutex<Option<AppInfoCache>> = Mutex::new(None);

// ─── Steam path detection ───────────────────────────────────────────

#[cfg(target_os = "windows")]
fn detect_steam_path() -> Option<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey("Software\\Valve\\Steam") {
        if let Ok(path) = key.get_value::<String, _>("SteamPath") {
            let p = PathBuf::from(&path);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn detect_steam_path() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        let p = home.join(".steam").join("steam");
        if p.exists() {
            return Some(p);
        }
        let p2 = home.join(".local/share/Steam");
        if p2.exists() {
            return Some(p2);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn detect_steam_path() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        let p = home.join("Library/Application Support/Steam");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn detect_steam_path() -> Option<PathBuf> {
    None
}

fn find_userdata_path(steam_path: &Path) -> Option<PathBuf> {
    let ud = steam_path.join("userdata");
    if ud.exists() && ud.is_dir() {
        Some(ud)
    } else {
        None
    }
}

// ─── VDF parsing for persona name ──────────────────────────────────

fn get_persona_name(userdata_path: &Path, user_id: &str) -> String {
    let config_path = userdata_path
        .join(user_id)
        .join("config")
        .join("localconfig.vdf");
    if !config_path.exists() {
        return user_id.to_string();
    }

    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return user_id.to_string(),
    };

    // Extract PersonaName using regex: "PersonaName"<tabs/spaces>"<name>"
    // Example: 		"PersonaName"		"NiceStalker"
    let re = regex::Regex::new(r#""PersonaName"\s+"([^"]+)""#).unwrap();
    if let Some(captures) = re.captures(&content) {
        if let Some(name) = captures.get(1) {
            let name_str = name.as_str().trim();
            if !name_str.is_empty() {
                return name_str.to_string();
            }
        }
    }

    user_id.to_string()
}

fn normalize_path(path: &Path) -> String {
    // Convert to string and normalize slashes to forward slashes
    path.to_string_lossy().replace('\\', "/").to_string()
}

// ─── Steam library discovery ────────────────────────────────────────

fn find_all_steamapps_dirs(steam_path: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let main_steamapps = steam_path.join("steamapps");
    if main_steamapps.exists() {
        dirs.push(main_steamapps.clone());
    }

    // Parse libraryfolders.vdf to find additional library paths
    let library_file = main_steamapps.join("libraryfolders.vdf");
    if library_file.exists() {
        if let Ok(content) = fs::read_to_string(&library_file) {
            let re = regex::Regex::new(r#""path"\s+"([^"]+)""#).unwrap();
            for captures in re.captures_iter(&content) {
                if let Some(path_match) = captures.get(1) {
                    let raw = path_match.as_str().replace("\\\\", "\\");
                    let lib_path = PathBuf::from(&raw);
                    let lib_steamapps = lib_path.join("steamapps");
                    if lib_steamapps.exists() && !dirs.iter().any(|d| d == &lib_steamapps) {
                        dirs.push(lib_steamapps);
                    }
                }
            }
        }
    }

    dirs
}

fn get_appinfo_games(steam_path: &Path) -> HashMap<String, CachedGameEntry> {
    let appinfo_path = steam_path.join("appcache").join("appinfo.vdf");
    if !appinfo_path.exists() {
        return HashMap::new();
    }

    let current_modified = fs::metadata(&appinfo_path)
        .ok()
        .and_then(|m| m.modified().ok());

    // Check cache validity
    {
        let cache = APP_INFO_CACHE.lock().unwrap();
        if let Some(ref c) = *cache {
            let cache_valid = match (&c.last_modified, &current_modified) {
                (Some(cached), Some(current)) => cached == current,
                _ => false,
            };
            if cache_valid {
                return c.games.clone();
            }
        }
    }

    // Parse the VDF file
    let appinfo_vdf: Map<String, Value> = open_appinfo_vdf(&appinfo_path, Some(true));

    let mut games = HashMap::new();

    if let Some(Value::Array(entries)) = appinfo_vdf.get("entries") {
        for entry in entries {
            let appid = match entry.get("appid") {
                Some(Value::Number(n)) => n.to_string(),
                _ => continue,
            };

            let name = entry
                .get("common")
                .and_then(|c| c.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();

            if name.is_empty() {
                continue;
            }

            let mut executables = Vec::new();
            if let Some(launch) = entry.get("config").and_then(|c| c.get("launch")) {
                if let Some(launch_map) = launch.as_object() {
                    for (_, launch_config) in launch_map {
                        if let Some(exe_path) =
                            launch_config.get("executable").and_then(|e| e.as_str())
                        {
                            let normalized = exe_path.replace('\\', "/");
                            if let Some(filename) = normalized.rsplit('/').next() {
                                let filename = filename.to_string();
                                if !filename.is_empty() && !executables.contains(&filename) {
                                    executables.push(filename);
                                }
                            }
                        }
                    }
                }
            }

            games.insert(appid, CachedGameEntry { name, executables });
        }
    }

    // Update cache
    {
        let mut cache = APP_INFO_CACHE.lock().unwrap();
        *cache = Some(AppInfoCache {
            last_modified: current_modified,
            games: games.clone(),
        });
    }

    games
}

fn get_game_name_from_manifest(steamapps_dirs: &[PathBuf], game_id: &str) -> Option<String> {
    let manifest_name = format!("appmanifest_{}.acf", game_id);
    for dir in steamapps_dirs {
        let manifest_path = dir.join(&manifest_name);
        if manifest_path.exists() {
            if let Ok(content) = fs::read_to_string(&manifest_path) {
                let re = regex::Regex::new(r#""name"\s+"([^"]+)""#).unwrap();
                if let Some(captures) = re.captures(&content) {
                    if let Some(name) = captures.get(1) {
                        let name_str = name.as_str().trim();
                        if !name_str.is_empty() {
                            return Some(name_str.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

fn get_game_info(
    appinfo_games: &HashMap<String, CachedGameEntry>,
    steamapps_dirs: &[PathBuf],
    game_id: &str,
) -> Option<(String, Vec<String>)> {
    // Try appinfo.vdf cache first
    if let Some(entry) = appinfo_games.get(game_id) {
        return Some((entry.name.clone(), entry.executables.clone()));
    }

    // Fall back to appmanifest files
    if let Some(name) = get_game_name_from_manifest(steamapps_dirs, game_id) {
        return Some((name, vec![]));
    }

    None
}

fn has_meaningful_game_data(game_path: &Path) -> bool {
    let entries = match fs::read_dir(game_path) {
        Ok(e) => e,
        Err(_) => return false,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.eq_ignore_ascii_case("remotecache.vdf") && path.is_file() {
                continue;
            }
        }
        return true;
    }

    false
}

fn count_profile_games(
    profile_path: &Path,
    appinfo_games: &HashMap<String, CachedGameEntry>,
    steamapps_dirs: &[PathBuf],
) -> usize {
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(profile_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let folder_name = match path.file_name() {
                Some(n) => n.to_string_lossy().to_string(),
                None => continue,
            };
            if !folder_name.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            if !has_meaningful_game_data(&path) {
                continue;
            }
            if get_game_info(appinfo_games, steamapps_dirs, &folder_name).is_some() {
                count += 1;
            }
        }
    }
    count
}

// ─── Profile discovery ──────────────────────────────────────────────

fn discover_profiles(userdata_path: &Path, steam_path: &Path, steamapps_dirs: &[PathBuf]) -> Vec<Profile> {
    let mut profiles = Vec::new();
    let appinfo_games = get_appinfo_games(steam_path);

    if !userdata_path.exists() {
        return profiles;
    }

    let entries = match fs::read_dir(userdata_path) {
        Ok(e) => e,
        Err(_) => return profiles,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let folder_name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };

        // Skip dunabackups folder
        if folder_name == "dunabackups" {
            continue;
        }

        // Skip non-numeric folders (not user IDs)
        if !folder_name.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }

        // Must have config/localconfig.vdf - this is mandatory
        let has_config = path.join("config").join("localconfig.vdf").exists();
        if !has_config {
            continue;
        }

        let game_count = count_profile_games(&path, &appinfo_games, steamapps_dirs);
        let name = get_persona_name(userdata_path, &folder_name);
        
        // Get last login time from localconfig.vdf modification date
        let last_login = path
            .join("config")
            .join("localconfig.vdf")
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        profiles.push(Profile {
            id: folder_name,
            name,
            game_count,
            is_backup: false,
            path: normalize_path(&path),
            last_login: format_timestamp(last_login),
        });
    }

    // Also discover backup profiles
    let backups_dir = userdata_path.join("dunabackups");
    if backups_dir.exists() {
        if let Ok(entries) = fs::read_dir(&backups_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let folder_name = match path.file_name() {
                    Some(n) => n.to_string_lossy().to_string(),
                    None => continue,
                };

                let game_count = count_profile_games(&path, &appinfo_games, steamapps_dirs);

                let name = get_persona_name(userdata_path, &folder_name);
                let display_name = if name == folder_name {
                    format!("Backup - {}", folder_name)
                } else {
                    format!("Backup - {}", name)
                };
                
                // For backups, get the latest modification time from any file in the backup folder
                let last_login = get_latest_modified_time(&path);

                if game_count > 0 {
                    profiles.push(Profile {
                        id: folder_name,
                        name: display_name,
                        game_count,
                        is_backup: true,
                        path: normalize_path(&path),
                        last_login: format_timestamp(last_login),
                    });
                }
            }
        }
    }

    // Sort profiles: regular profiles first, then backups, each sorted by last login (most recent first)
    profiles.sort_by(|a, b| {
        // First compare by backup status (false < true, so regular profiles come first)
        match a.is_backup.cmp(&b.is_backup) {
            std::cmp::Ordering::Equal => {
                // Within the same group, sort by last login (most recent first)
                b.last_login.cmp(&a.last_login)
            }
            other => other,
        }
    });

    profiles
}

// ─── Timestamp formatting ───────────────────────────────────────────

fn format_timestamp(secs: u64) -> String {
    use chrono::{DateTime, Utc};
    if secs == 0 {
        return "Never".to_string();
    }
    let dt = DateTime::<Utc>::from_timestamp(secs as i64, 0)
        .unwrap_or_else(|| DateTime::<Utc>::from_timestamp(0, 0).unwrap());
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn get_latest_modified_time(dir: &Path) -> u64 {
    let mut latest: Option<SystemTime> = None;
    
    for entry in WalkDir::new(dir).into_iter().flatten() {
        if entry.path().is_file() {
            if let Ok(metadata) = fs::metadata(entry.path()) {
                if let Ok(modified) = metadata.modified() {
                    latest = Some(match latest {
                        Some(current) if modified > current => modified,
                        Some(current) => current,
                        None => modified,
                    });
                }
            }
        }
    }
    
    latest
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ─── File stats ─────────────────────────────────────────────────────

fn get_dir_stats(dir: &Path) -> (u64, usize, usize, Option<SystemTime>) {
    let mut total_size: u64 = 0;
    let mut file_count: usize = 0;
    let mut folder_count: usize = 0;
    let mut latest_modified: Option<SystemTime> = None;

    for entry in WalkDir::new(dir).into_iter().flatten() {
        let path = entry.path();
        if path.is_file() {
            file_count += 1;
            if let Ok(metadata) = fs::metadata(path) {
                total_size += metadata.len();
                if let Ok(modified) = metadata.modified() {
                    latest_modified = Some(match latest_modified {
                        Some(current) => {
                            if modified > current {
                                modified
                            } else {
                                current
                            }
                        }
                        None => modified,
                    });
                }
            }
        } else if path.is_dir() && path != dir {
            folder_count += 1;
        }
    }

    (total_size, file_count, folder_count, latest_modified)
}

fn format_system_time(time: SystemTime) -> String {
    let datetime: chrono::DateTime<chrono::Local> = time.into();
    datetime.format("%Y-%m-%d %H:%M:%S").to_string()
}

// ─── Tauri commands ─────────────────────────────────────────────────

#[tauri::command]
fn detect_steam() -> Result<AppState, String> {
    let steam_path = detect_steam_path().ok_or("Could not detect Steam installation")?;
    let userdata_path = find_userdata_path(&steam_path)
        .ok_or("Could not find userdata folder in Steam directory")?;

    Ok(AppState {
        userdata_path: normalize_path(&userdata_path),
        steam_path: normalize_path(&steam_path),
    })
}

#[tauri::command]
fn validate_steam_path(path: String) -> Result<AppState, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }

    // Check if user gave us the userdata folder directly
    if p.file_name().map(|n| n == "userdata").unwrap_or(false) && p.is_dir() {
        let has_numeric = fs::read_dir(&p)
            .map(|entries| {
                entries.flatten().any(|e| {
                    e.path().is_dir()
                        && e.file_name()
                            .to_string_lossy()
                            .chars()
                            .all(|c| c.is_ascii_digit())
                })
            })
            .unwrap_or(false);

        if has_numeric {
            let steam_path = p.parent().unwrap_or(&p);
            return Ok(AppState {
                userdata_path: normalize_path(&p),
                steam_path: normalize_path(steam_path),
            });
        }
    }

    // Check if it's a Steam folder with userdata inside
    if let Some(ud) = find_userdata_path(&p) {
        return Ok(AppState {
            userdata_path: normalize_path(&ud),
            steam_path: normalize_path(&p),
        });
    }

    Err("Could not find 'userdata' folder. Please select the Steam folder or the userdata folder directly.".to_string())
}

#[tauri::command]
fn get_profiles(userdata_path: String, steam_path: String) -> Vec<Profile> {
    let steam = Path::new(&steam_path);
    let steamapps_dirs = find_all_steamapps_dirs(steam);
    discover_profiles(Path::new(&userdata_path), steam, &steamapps_dirs)
}

#[tauri::command]
fn get_games_for_profile(
    steam_path: String,
    userdata_path: String,
    profile_id: String,
    is_backup: bool,
) -> Vec<GameInfo> {
    let ud = PathBuf::from(&userdata_path);
    let steam = Path::new(&steam_path);
    let steamapps_dirs = find_all_steamapps_dirs(steam);
    let appinfo_games = get_appinfo_games(steam);

    let profile_path = if is_backup {
        ud.join("dunabackups").join(&profile_id)
    } else {
        ud.join(&profile_id)
    };

    let mut games = Vec::new();
    if let Ok(entries) = fs::read_dir(&profile_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let folder_name = match path.file_name() {
                Some(n) => n.to_string_lossy().to_string(),
                None => continue,
            };
            if !folder_name.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            if !has_meaningful_game_data(&path) {
                continue;
            }
            if let Some((name, _)) = get_game_info(&appinfo_games, &steamapps_dirs, &folder_name) {
                games.push(GameInfo {
                    id: folder_name,
                    name,
                });
            }
        }
    }

    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

#[tauri::command]
fn get_swap_summary(
    userdata_path: String,
    steam_path: String,
    source_id: String,
    source_is_backup: bool,
    target_ids: Vec<String>,
    game_ids: Vec<String>,
) -> Result<SwapSummary, String> {
    let ud = PathBuf::from(&userdata_path);
    let steam = Path::new(&steam_path);
    let steamapps_dirs = find_all_steamapps_dirs(steam);
    let profiles = discover_profiles(&ud, steam, &steamapps_dirs);

    let source = profiles
        .iter()
        .find(|p| p.id == source_id && p.is_backup == source_is_backup)
        .ok_or("Source profile not found")?
        .clone();

    let targets: Vec<Profile> = profiles
        .iter()
        .filter(|p| target_ids.contains(&p.id) && !p.is_backup)
        .cloned()
        .collect();

    if targets.is_empty() {
        return Err("No valid target profiles found".to_string());
    }

    if game_ids.is_empty() {
        return Err("No games selected".to_string());
    }

    let source_base = if source.is_backup {
        ud.join("dunabackups").join(&source.id)
    } else {
        ud.join(&source.id)
    };

    let mut total_size: u64 = 0;
    let mut file_count: usize = 0;
    let mut folder_count: usize = 0;
    let mut latest_modified: Option<SystemTime> = None;

    for game_id in &game_ids {
        let game_path = source_base.join(game_id);
        if game_path.exists() {
            let (size, files, folders, modified) = get_dir_stats(&game_path);
            total_size += size;
            file_count += files;
            folder_count += folders;
            if let Some(mod_time) = modified {
                latest_modified = Some(match latest_modified {
                    Some(current) if mod_time > current => mod_time,
                    Some(current) => current,
                    None => mod_time,
                });
            }
        }
    }

    let last_modified_str = latest_modified
        .map(format_system_time)
        .unwrap_or_else(|| "Unknown".to_string());

    Ok(SwapSummary {
        source,
        targets,
        source_last_modified: last_modified_str,
        source_total_size: total_size,
        source_file_count: file_count,
        source_folder_count: folder_count,
    })
}

#[tauri::command]
fn execute_swap(
    userdata_path: String,
    source_id: String,
    source_is_backup: bool,
    target_ids: Vec<String>,
    game_ids: Vec<String>,
) -> SwapResult {
    let ud = PathBuf::from(&userdata_path);
    let mut details = Vec::new();

    let source_base = if source_is_backup {
        ud.join("dunabackups").join(&source_id)
    } else {
        ud.join(&source_id)
    };

    // Verify at least one source game folder exists
    let has_any_source = game_ids.iter().any(|gid| source_base.join(gid).exists());
    if !has_any_source {
        return SwapResult {
            success: false,
            message: "Source game data not found".to_string(),
            details: vec![],
        };
    }

    let backups_dir = ud.join("dunabackups");
    if let Err(e) = fs::create_dir_all(&backups_dir) {
        return SwapResult {
            success: false,
            message: format!("Failed to create backups directory: {}", e),
            details: vec![],
        };
    }

    for target_id in &target_ids {
        for game_id in &game_ids {
            let source_game = source_base.join(game_id);
            if !source_game.exists() {
                details.push(format!(
                    "Warning: Source has no data for game {} — skipped for target {}",
                    game_id, target_id
                ));
                continue;
            }

            let target_game = ud.join(target_id).join(game_id);

            // Step 1: Backup existing target game data
            if target_game.exists() {
                let backup_game = backups_dir.join(target_id).join(game_id);
                if backup_game.exists() {
                    if let Err(e) = fs::remove_dir_all(&backup_game) {
                        details.push(format!(
                            "Warning: Failed to remove old backup for {}/{}: {}",
                            target_id, game_id, e
                        ));
                    }
                }

                if let Err(e) = fs::create_dir_all(&backup_game) {
                    details.push(format!(
                        "Warning: Failed to create backup dir for {}/{}: {}",
                        target_id, game_id, e
                    ));
                    continue;
                }

                match copy_dir_recursive(&target_game, &backup_game) {
                    Ok(_) => details.push(format!(
                        "Backed up game {} for profile {} to dunabackups",
                        game_id, target_id
                    )),
                    Err(e) => {
                        details.push(format!(
                            "Warning: Backup failed for {}/{}: {}",
                            target_id, game_id, e
                        ));
                        continue;
                    }
                }
            }

            // Step 2: Delete target game folder
            if target_game.exists() {
                if let Err(e) = fs::remove_dir_all(&target_game) {
                    details.push(format!(
                        "Error: Failed to clear target {}/{}: {}",
                        target_id, game_id, e
                    ));
                    continue;
                }
            }

            // Step 3: Copy source game folder to target
            if let Err(e) = fs::create_dir_all(&target_game) {
                details.push(format!(
                    "Error: Failed to create target dir for {}/{}: {}",
                    target_id, game_id, e
                ));
                continue;
            }

            match copy_dir_recursive(&source_game, &target_game) {
                Ok(_) => details.push(format!(
                    "Successfully swapped game {} for profile {}",
                    game_id, target_id
                )),
                Err(e) => {
                    details.push(format!(
                        "Error: Failed to copy game {} to {}: {}",
                        game_id, target_id, e
                    ));
                    continue;
                }
            }
        }
    }

    let all_success = !details.iter().any(|d| d.starts_with("Error:"));

    SwapResult {
        success: all_success,
        message: if all_success {
            "All games swapped successfully!".to_string()
        } else {
            "Some operations failed. Check details.".to_string()
        },
        details,
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !dst.exists() {
        fs::create_dir_all(dst).map_err(|e| format!("Failed to create dir {:?}: {}", dst, e))?;
    }

    let entries = fs::read_dir(src).map_err(|e| format!("Failed to read dir {:?}: {}", src, e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy {:?} -> {:?}: {}", src_path, dst_path, e))?;
        }
    }

    Ok(())
}

#[tauri::command]
fn check_games_running(steam_path: String, game_ids: Vec<String>) -> bool {
    if game_ids.is_empty() {
        return false;
    }

    let appinfo_games = get_appinfo_games(Path::new(&steam_path));

    let mut exe_names: Vec<String> = Vec::new();
    for game_id in &game_ids {
        if let Some(info) = appinfo_games.get(game_id) {
            exe_names.extend(info.executables.iter().cloned());
        }
    }

    if exe_names.is_empty() {
        return false;
    }

    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    sys.processes()
        .values()
        .any(|p| {
            let pname = p.name().to_string_lossy();
            exe_names.iter().any(|exe| pname.eq_ignore_ascii_case(exe))
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            detect_steam,   
            validate_steam_path,
            get_profiles,
            get_games_for_profile,
            get_swap_summary,
            execute_swap,
            check_games_running,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
