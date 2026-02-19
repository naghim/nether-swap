use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use sysinfo::System;
use walkdir::WalkDir;

// ─── Data structures ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub has_dota2: bool,
    pub is_backup: bool,
    pub path: String,
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
    path.to_string_lossy()
        .replace('\\', "/")
        .to_string()
}

// ─── Profile discovery ──────────────────────────────────────────────

fn discover_profiles(userdata_path: &Path) -> Vec<Profile> {
    let mut profiles = Vec::new();

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

        let has_dota2 = path.join("570").exists();
        let name = get_persona_name(userdata_path, &folder_name);

        profiles.push(Profile {
            id: folder_name,
            name,
            has_dota2,
            is_backup: false,
            path: normalize_path(&path),
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

                let has_dota2_content = path.join("570").exists()
                    || fs::read_dir(&path).map(|e| e.count() > 0).unwrap_or(false);

                let name = get_persona_name(userdata_path, &folder_name);
                let display_name = if name == folder_name {
                    format!("Backup - {}", folder_name)
                } else {
                    format!("Backup - {}", name)
                };

                if has_dota2_content {
                    profiles.push(Profile {
                        id: folder_name,
                        name: display_name,
                        has_dota2: true,
                        is_backup: true,
                        path: normalize_path(&path),
                    });
                }
            }
        }
    }

    profiles
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
fn get_profiles(userdata_path: String) -> Vec<Profile> {
    discover_profiles(Path::new(&userdata_path))
}

#[tauri::command]
fn get_swap_summary(
    userdata_path: String,
    source_id: String,
    source_is_backup: bool,
    target_ids: Vec<String>,
) -> Result<SwapSummary, String> {
    let ud = PathBuf::from(&userdata_path);
    let profiles = discover_profiles(&ud);

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

    let source_dota_path = if source.is_backup {
        ud.join("dunabackups").join(&source.id).join("570")
    } else {
        ud.join(&source.id).join("570")
    };

    let actual_source = if source_dota_path.exists() {
        source_dota_path
    } else if source.is_backup {
        ud.join("dunabackups").join(&source.id)
    } else {
        return Err("Source has no Dota 2 data".to_string());
    };

    let (total_size, file_count, folder_count, latest_modified) = get_dir_stats(&actual_source);

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
) -> SwapResult {
    let ud = PathBuf::from(&userdata_path);
    let mut details = Vec::new();

    let source_570 = if source_is_backup {
        let p = ud.join("dunabackups").join(&source_id).join("570");
        if p.exists() {
            p
        } else {
            ud.join("dunabackups").join(&source_id)
        }
    } else {
        ud.join(&source_id).join("570")
    };

    if !source_570.exists() {
        return SwapResult {
            success: false,
            message: "Source Dota 2 data not found".to_string(),
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
        let target_570 = ud.join(target_id).join("570");

        // Step 1: Backup existing target data if 570 exists
        if target_570.exists() {
            let backup_target = backups_dir.join(target_id);
            if backup_target.exists() {
                if let Err(e) = fs::remove_dir_all(&backup_target) {
                    details.push(format!(
                        "Warning: Failed to remove old backup for {}: {}",
                        target_id, e
                    ));
                }
            }

            let backup_570 = backup_target.join("570");
            if let Err(e) = fs::create_dir_all(&backup_570) {
                details.push(format!(
                    "Warning: Failed to create backup dir for {}: {}",
                    target_id, e
                ));
                continue;
            }

            match copy_dir_recursive(&target_570, &backup_570) {
                Ok(_) => details.push(format!("Backed up profile {} to dunabackups", target_id)),
                Err(e) => {
                    details.push(format!("Warning: Backup failed for {}: {}", target_id, e));
                    continue;
                }
            }
        }

        // Step 2: Delete target 570 contents
        if target_570.exists() {
            if let Err(e) = fs::remove_dir_all(&target_570) {
                details.push(format!(
                    "Error: Failed to clear target {} 570 folder: {}",
                    target_id, e
                ));
                continue;
            }
        }

        // Step 3: Create target 570 dir and copy source into it
        if let Err(e) = fs::create_dir_all(&target_570) {
            details.push(format!(
                "Error: Failed to create target 570 dir for {}: {}",
                target_id, e
            ));
            continue;
        }

        match copy_dir_recursive(&source_570, &target_570) {
            Ok(_) => details.push(format!("Successfully swapped profile {}", target_id)),
            Err(e) => {
                details.push(format!("Error: Failed to copy to {}: {}", target_id, e));
                continue;
            }
        }
    }

    let all_success = !details.iter().any(|d| d.starts_with("Error:"));

    SwapResult {
        success: all_success,
        message: if all_success {
            "All profiles swapped successfully!".to_string()
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

    let entries =
        fs::read_dir(src).map_err(|e| format!("Failed to read dir {:?}: {}", src, e))?;

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
fn check_dota2_running() -> bool {
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let dota_name = if cfg!(target_os = "windows") {
        "dota2.exe"
    } else {
        "dota2"
    };

    sys.processes()
        .values()
        .any(|p| p.name().to_string_lossy().eq_ignore_ascii_case(dota_name))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            detect_steam,
            validate_steam_path,
            get_profiles,
            get_swap_summary,
            execute_swap,
            check_dota2_running,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
