import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { Store } from "@tauri-apps/plugin-store";
import {
  Check,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Sun,
  Moon,
  Folder,
  ArrowRightLeft,
  ArrowRight,
  RotateCcw,
  Settings,
  Archive,
  FolderOpen,
  Search,
} from "lucide-react";
import "./App.css";

// ─── Types ──────────────────────────────────────────────────

interface Profile {
  id: string;
  name: string;
  game_count: number;
  is_backup: boolean;
  path: string;
  last_login: string;
}

interface GameInfo {
  id: string;
  name: string;
}

interface AppStateData {
  userdata_path: string;
  steam_path: string;
}

interface SwapSummary {
  source: Profile;
  targets: Profile[];
  source_last_modified: string;
  source_total_size: number;
  source_file_count: number;
  source_folder_count: number;
}

interface SwapResult {
  success: boolean;
  message: string;
  details: string[];
}

interface SwapConfiguration {
  source: { id: string; isBackup: boolean };
  games: string[];
  targets: string[];
}

// ─── Helpers ────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function getInitials(name: string): string {
  return name
    .replace(/^Backup - /, "")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function normalize_display_path(path: string): string {
  // Normalize all backslashes to forward slashes
  return path.replace(/\\/g, "/");
}

// ─── Main App ───────────────────────────────────────────────

function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [screen, setScreen] = useState<"setup" | "main">("setup");
  const [userdataPath, setUserdataPath] = useState("");
  const [steamPath, setSteamPath] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedSource, setSelectedSource] = useState<{
    id: string;
    isBackup: boolean;
  } | null>(null);
  const [games, setGames] = useState<GameInfo[]>([]);
  const [selectedGames, setSelectedGames] = useState<string[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [summary, setSummary] = useState<SwapSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [swapResult, setSwapResult] = useState<SwapResult | null>(null);
  const [gamesRunning, setGamesRunning] = useState(false);
  const [setupStatus, setSetupStatus] = useState<
    "searching" | "found" | "error" | "idle"
  >("searching");
  const [setupError, setSetupError] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [loadedConfig, setLoadedConfig] = useState(false);
  const [gameFilter, setGameFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [targetFilter, setTargetFilter] = useState("");
  const gameCheckRef = useRef<ReturnType<typeof setInterval>>();
  const storeRef = useRef<Store | null>(null);

  // Initialize store
  useEffect(() => {
    (async () => {
      storeRef.current = await Store.load("settings.json");
    })();
  }, []);

  // Theme effect
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Auto-detect Steam on mount
  useEffect(() => {
    (async () => {
      try {
        const state = await invoke<AppStateData>("detect_steam");
        setUserdataPath(state.userdata_path);
        setSteamPath(state.steam_path);
        setSetupStatus("found");
        setScreen("main"); // Go straight to main screen
      } catch {
        setSetupStatus("error");
        setSetupError(
          "Could not auto-detect Steam. Please select the folder manually.",
        );
      }
    })();
  }, []);

  // Game process check
  useEffect(() => {
    if (screen !== "main") return;
    const check = async () => {
      try {
        const running = await invoke<boolean>("check_games_running", {
          steamPath,
          gameIds: selectedGames,
        });
        setGamesRunning(running);
      } catch {
        /* ignore */
      }
    };
    check();
    gameCheckRef.current = setInterval(check, 5000);
    return () => clearInterval(gameCheckRef.current);
  }, [screen, steamPath, selectedGames]);

  // Load profiles when entering main screen
  const loadProfiles = useCallback(
    async (manual: boolean) => {
      if (!userdataPath || !steamPath) return;
      try {
        const profs = await invoke<Profile[]>("get_profiles", { userdataPath, steamPath });
        setProfiles(profs);

        if (manual) {
          setToast("Profiles refreshed");
          setTimeout(() => setToast(null), 2000);
        }
      } catch {
        setToast("Failed to load profiles");
        setTimeout(() => setToast(null), 3000);
      }
    },
    [userdataPath, steamPath],
  );

  useEffect(() => {
    if (screen === "main") {
      loadProfiles(false);
    }
  }, [screen, loadProfiles]);

  // Load games when source changes
  useEffect(() => {
    if (!selectedSource || !steamPath || !userdataPath) {
      setGames([]);
      setSelectedGames([]);
      return;
    }

    (async () => {
      try {
        const g = await invoke<GameInfo[]>("get_games_for_profile", {
          steamPath,
          userdataPath,
          profileId: selectedSource.id,
          isBackup: selectedSource.isBackup,
        });
        setGames(g);
      } catch {
        setGames([]);
      }
    })();
  }, [selectedSource, steamPath, userdataPath]);

  // Load summary when selection changes
  useEffect(() => {
    if (
      !selectedSource ||
      selectedTargets.length === 0 ||
      selectedGames.length === 0
    ) {
      setSummary(null);
      return;
    }

    let cancelled = false;
    setLoadingSummary(true);

    (async () => {
      try {
        const s = await invoke<SwapSummary>("get_swap_summary", {
          userdataPath,
          steamPath,
          sourceId: selectedSource.id,
          sourceIsBackup: selectedSource.isBackup,
          targetIds: selectedTargets,
          gameIds: selectedGames,
        });
        if (!cancelled) setSummary(s);
      } catch {
        if (!cancelled) setSummary(null);
      } finally {
        if (!cancelled) setLoadingSummary(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedSource, selectedTargets, selectedGames, userdataPath, steamPath]);

  useEffect(() => {
    async function restoreConfig() {
      if (!storeRef.current) return;
      if (profiles.length === 0) return; // Wait until profiles are loaded
      if (loadedConfig) return; // Only attempt to load config once
      const config = await storeRef.current.get<SwapConfiguration>("swapConfiguration");

      console.log("Restoring config:", config);

      // Restore source if it exists
      if (!config?.source) {
        return;
      }
      const sourceExists = profiles.some(
        (p) => p.id === config.source.id && p.is_backup === config.source.isBackup
      );
      if (sourceExists) {
        setSelectedSource(config.source);

        // Wait for games to load, then restore game selection
        if (config.games && config.games.length > 0) {
          try {
            const availableGames = await invoke<GameInfo[]>("get_games_for_profile", {
              steamPath,
              userdataPath,
              profileId: config.source.id,
              isBackup: config.source.isBackup,
            });
            const gameIds = availableGames.map((g) => g.id);
            const validGames = config.games.filter((gid) => gameIds.includes(gid));
            if (validGames.length > 0) {
              setSelectedGames(validGames);
            }
          } catch {
            /* ignore */
          }
        }

        // Restore targets if they exist
        if (config.targets && config.targets.length > 0) {
          const validTargets = config.targets.filter((tid) =>
            profiles.some((p) => p.id === tid && !p.is_backup)
          );
          if (validTargets.length > 0) {
            setSelectedTargets(validTargets);
          }
        }

      }

      setLoadedConfig(true);
    }

    restoreConfig();
  }, [storeRef.current, profiles]);

  // ─── Handlers ───────────────────────────────────────────

  const handleManualSelect = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Select Steam or userdata folder",
    });
    if (!selected) return;

    const wasOnMainScreen = screen === "main";

    try {
      const state = await invoke<AppStateData>("validate_steam_path", {
        path: selected,
      });
      setUserdataPath(state.userdata_path);
      setSteamPath(state.steam_path);
      setSetupStatus("found");
      setSetupError("");
      setScreen("main");

      if (wasOnMainScreen) {
        setToast("Steam path updated");
        setTimeout(() => setToast(null), 2000);
      }
    } catch (e) {
      setSetupError(String(e));
      setSetupStatus("error");
      setToast("Failed to validate Steam path");
      setTimeout(() => setToast(null), 3000);
    }
  };

  const handleContinue = () => {
    if (userdataPath) {
      setScreen("main");
    }
  };

  const handleSourceSelect = (profile: Profile) => {
    // Source must have game data
    if (profile.game_count === 0) return;
    const key = { id: profile.id, isBackup: profile.is_backup };
    if (
      selectedSource?.id === key.id &&
      selectedSource?.isBackup === key.isBackup
    ) {
      setSelectedSource(null);
      setSelectedTargets([]);
      setSelectedGames([]);
    } else {
      setSelectedSource(key);
      setSelectedTargets([]);
      setSelectedGames([]);
    }
    setSourceFilter(""); // Reset search filter after selecting a profile
  };

  const handleTargetToggle = (profile: Profile) => {
    // Can't select target before selecting a source and games
    if (!selectedSource || selectedGames.length === 0) return;
    // Can't select backup as target
    if (profile.is_backup) return;
    // Can't select the same profile as source (unless it's a backup source)
    if (
      selectedSource &&
      !selectedSource.isBackup &&
      profile.id === selectedSource.id
    )
      return;

    setSelectedTargets((prev) =>
      prev.includes(profile.id)
        ? prev.filter((id) => id !== profile.id)
        : [...prev, profile.id],
    );
    setTargetFilter(""); // Reset search filter after selecting a profile
  };

  const handleSwap = async () => {
    if (
      !selectedSource ||
      selectedTargets.length === 0 ||
      selectedGames.length === 0
    )
      return;
    setSwapping(true);
    try {
      const result = await invoke<SwapResult>("execute_swap", {
        userdataPath,
        sourceId: selectedSource.id,
        sourceIsBackup: selectedSource.isBackup,
        targetIds: selectedTargets,
        gameIds: selectedGames,
      });
      setSwapResult(result);

      // Save last configuration on successful swap
      if (result.success && storeRef.current) {
        const config: SwapConfiguration = {
          source: selectedSource,
          games: selectedGames,
          targets: selectedTargets,
        };
        await storeRef.current.set("swapConfiguration", config);
        await storeRef.current.save();
      }

      // Refresh profiles after swap
      await loadProfiles(false);
    } catch (e) {
      setSwapResult({ success: false, message: String(e), details: [] });
    } finally {
      setSwapping(false);
    }
  };

  const handleCloseResult = () => {
    setSwapResult(null);
    setSelectedSource(null);
    setSelectedTargets([]);
    setSelectedGames([]);
    setSummary(null);
  };

  const handleOpenFolder = async (profilePath: string) => {
    try {
      await openPath(profilePath);
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  };

  // ─── Derived data ──────────────────────────────────────

  const sourceProfiles = profiles.filter((p) => p.game_count > 0);
  const targetProfiles = profiles.filter((p) => !p.is_backup);
    // Filter profiles by search term (case-insensitive)
  const filteredSourceProfiles = sourceProfiles.filter((profile) =>
    profile.name.toLowerCase().includes(sourceFilter.toLowerCase()) ||
    profile.id.includes(sourceFilter)
  );
  
  const filteredTargetProfiles = targetProfiles.filter((profile) =>
    profile.name.toLowerCase().includes(targetFilter.toLowerCase()) ||
    profile.id.includes(targetFilter)
  );
    // Filter games by search term (case-insensitive)
  const filteredGames = games.filter((game) =>
    game.name.toLowerCase().includes(gameFilter.toLowerCase()) ||
    game.id.includes(gameFilter)
  );

  const handleGameToggle = (gameId: string) => {
    if (!selectedSource) return;
    setSelectedGames((prev) =>
      prev.includes(gameId)
        ? prev.filter((id) => id !== gameId)
        : [...prev, gameId],
    );
    setGameFilter(""); // Reset search filter after selecting a game
  };

  // ─── Render: Setup ────────────────────────────────────

  if (screen === "setup") {
    return (
      <div className="app">
        <div className="setup-screen">
          <div className="setup-card">
            <h2>
              Nether <span>Swap</span>
            </h2>
            <p>
              Steam game configuration manager. Swap your config between
              accounts effortlessly.
            </p>

            {setupStatus === "searching" && (
              <div className="setup-status searching">
                <span className="spinner" /> Detecting Steam installation...
              </div>
            )}

            {setupStatus === "found" && (
              <div className="setup-status found">
                Steam detected successfully!
                <div className="setup-path">
                  {normalize_display_path(userdataPath)}
                </div>
              </div>
            )}

            {setupStatus === "error" && (
              <div className="setup-status error">{setupError}</div>
            )}

            <div className="setup-actions">
              {setupStatus === "found" && (
                <button className="btn btn-primary" onClick={handleContinue}>
                  Continue
                </button>
              )}
              <button
                className="btn btn-secondary"
                onClick={handleManualSelect}
              >
                {setupStatus === "found"
                  ? "Choose Different Folder"
                  : "Select Steam Folder"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Render: Main ─────────────────────────────────────

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <h1>
            Nether <span>Swap</span>
          </h1>
          <span
            className="steam-path-display"
            title={normalize_display_path(userdataPath)}
          >
            {normalize_display_path(userdataPath)}
          </span>
          <button
            className="theme-toggle"
            onClick={() => handleManualSelect()}
            title="Change Steam installation"
          >
            <Settings size={14} />
          </button>
        </div>
        <div className="header-right">
          <button
            className="theme-toggle"
            onClick={() => loadProfiles(true)}
            title="Refresh profiles"
          >
            <RotateCcw size={14} />
          </button>
          <button
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
      </header>

      {/* Game Running Warning */}
      {gamesRunning && (
        <div className="game-warning">
          <AlertTriangle size={16} />
          A game process was detected running. Close any games before swapping
          their configuration.
        </div>
      )}

      {/* Main Content */}
      <div className="main-content">
        <div className="description-text">
          Swap your game configuration between Steam accounts effortlessly
        </div>
        <div className="panes-container">
          {/* Source Pane */}
          <div className="pane">
            <div className="pane-header">
              <span className="pane-title">Source Profile</span>
              <span className="pane-badge">
                {sourceProfiles.length} available
              </span>
            </div>
            {sourceProfiles.length > 0 && (
              <div className="pane-search">
                <Search size={14} />
                <input
                  type="text"
                  placeholder="Search profiles..."
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  className="search-input"
                />
              </div>
            )}
            <div className="pane-list">
              {sourceProfiles.length === 0 ? (
                <div className="empty-state">
                  <Folder size={24} />
                  <p>No profiles with game data found</p>
                </div>
              ) : filteredSourceProfiles.length === 0 ? (
                <div className="empty-state">
                  <Search size={24} />
                  <p>No profiles match your search</p>
                </div>
              ) : (
                filteredSourceProfiles.map((profile) => {
                  const isSelected =
                    selectedSource?.id === profile.id &&
                    selectedSource?.isBackup === profile.is_backup;
                  return (
                    <div
                      key={`source-${profile.id}-${profile.is_backup}`}
                      className={`profile-card ${isSelected ? "selected" : ""} ${profile.is_backup ? "backup" : ""}`}
                      onClick={() => handleSourceSelect(profile)}
                    >
                      <div className="profile-avatar">
                        {profile.is_backup ? (
                          <Archive size={16} />
                        ) : (
                          getInitials(profile.name)
                        )}
                      </div>
                      <div className="profile-info">
                        <div className="profile-name">{profile.name}</div>
                        <div className="profile-meta">
                          <span className="text-muted">{profile.last_login}</span>
                          <span className="text-muted">•</span>
                          <span className="text-muted">ID: {profile.id}</span>
                        </div>
                      </div>
                      <div className="check-indicator">
                        <Check size={12} color="#fff" />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Games Pane */}
          <div className="pane">
            <div className="pane-header">
              <span className="pane-title">Games to Copy</span>
              <span className="pane-badge">
                {selectedGames.length} selected
              </span>
            </div>
            {selectedSource && games.length > 0 && (
              <div className="pane-search">
                <Search size={14} />
                <input
                  type="text"
                  placeholder="Search games..."
                  value={gameFilter}
                  onChange={(e) => setGameFilter(e.target.value)}
                  className="search-input"
                />
              </div>
            )}
            <div className="pane-list">
              {!selectedSource ? (
                <div className="empty-state">
                  <Folder size={24} />
                  <p>Select a source profile first</p>
                </div>
              ) : games.length === 0 ? (
                <div className="empty-state">
                  <Folder size={24} />
                  <p>No games found for this profile</p>
                </div>
              ) : filteredGames.length === 0 ? (
                <div className="empty-state">
                  <Search size={24} />
                  <p>No games match your search</p>
                </div>
              ) : (
                filteredGames.map((game) => {
                  const isSelected = selectedGames.includes(game.id);
                  return (
                    <div
                      key={`game-${game.id}`}
                      className={`profile-card ${isSelected ? "selected" : ""}`}
                      onClick={() => handleGameToggle(game.id)}
                    >
                      <div className="profile-avatar">
                        {game.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="profile-info">
                        <div className="profile-name">{game.name}</div>
                        <div className="profile-meta">
                          <span className="text-muted">ID: {game.id}</span>
                        </div>
                      </div>
                      <div className="check-indicator">
                        <Check size={12} color="#fff" />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Arrow Indicator */}
          <div className="pane-arrow">
            <ArrowRight size={24} />
          </div>

          {/* Target Pane */}
          <div className="pane">
            <div className="pane-header">
              <span className="pane-title">Target Profiles</span>
              <span className="pane-badge">
                {selectedTargets.length} selected
              </span>
            </div>
            {targetProfiles.length > 0 && (
              <div className="pane-search">
                <Search size={14} />
                <input
                  type="text"
                  placeholder="Search profiles..."
                  value={targetFilter}
                  onChange={(e) => setTargetFilter(e.target.value)}
                  className="search-input"
                />
              </div>
            )}
            <div className="pane-list">
              {targetProfiles.length === 0 ? (
                <div className="empty-state">
                  <Folder size={24} />
                  <p>No target profiles found</p>
                </div>
              ) : filteredTargetProfiles.length === 0 ? (
                <div className="empty-state">
                  <Search size={24} />
                  <p>No profiles match your search</p>
                </div>
              ) : (
                filteredTargetProfiles.map((profile) => {
                  const isSelected = selectedTargets.includes(profile.id);
                  const isSameAsSource =
                    !selectedSource?.isBackup &&
                    selectedSource?.id === profile.id;
                  const isDisabled =
                    !selectedSource ||
                    selectedGames.length === 0 ||
                    isSameAsSource;
                  return (
                    <div
                      key={`target-${profile.id}`}
                      className={`profile-card ${isSelected ? "selected" : ""} ${isDisabled ? "disabled" : ""}`}
                      onClick={() => !isDisabled && handleTargetToggle(profile)}
                    >
                      <div className="profile-avatar">
                        {getInitials(profile.name)}
                      </div>
                      <div className="profile-info">
                        <div className="profile-name">{profile.name}</div>
                        <div className="profile-meta">
                          <span className="text-muted">{profile.last_login}</span>
                          <span className="text-muted">•</span>
                          <span className="text-muted">ID: {profile.id}</span>
                        </div>
                      </div>
                      <div className="check-indicator">
                        <Check size={12} color="#fff" />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Summary Panel */}
        {(summary || loadingSummary) && (
          <div className="summary-panel">
            <div className="summary-header">
              <span className="summary-title">Swap Summary</span>
              {loadingSummary && <span className="spinner" />}
            </div>

            {summary && (
              <>
                <div className="summary-arrow">
                  <span className="from">{summary.source.name}</span>
                  <button
                    className="folder-open-btn"
                    onClick={() => handleOpenFolder(summary.source.path)}
                    title="Open source folder"
                  >
                    <FolderOpen size={14} />
                  </button>
                  <span className="arrow">&rarr;</span>
                  {summary.targets.map((t, i) => (
                    <span key={t.id}>
                      <span className="to">{t.name}</span>
                      <button
                        className="folder-open-btn"
                        onClick={() => handleOpenFolder(t.path)}
                        title="Open target folder"
                      >
                        <FolderOpen size={14} />
                      </button>
                      {i < summary.targets.length - 1 && (
                        <span className="text-muted">, </span>
                      )}
                    </span>
                  ))}
                </div>

                <div className="summary-grid">
                  <div className="summary-stat">
                    <div className="summary-stat-label">Last Modified</div>
                    <div className="summary-stat-value">
                      {summary.source_last_modified}
                    </div>
                  </div>
                  <div className="summary-stat">
                    <div className="summary-stat-label">Total Size</div>
                    <div className="summary-stat-value">
                      {formatBytes(summary.source_total_size)}
                    </div>
                  </div>
                  <div className="summary-stat">
                    <div className="summary-stat-label">Files</div>
                    <div className="summary-stat-value">
                      {summary.source_file_count}
                    </div>
                  </div>
                  <div className="summary-stat">
                    <div className="summary-stat-label">Folders</div>
                    <div className="summary-stat-value">
                      {summary.source_folder_count}
                    </div>
                  </div>
                </div>

                <button
                  className="btn btn-primary"
                  disabled={swapping || gamesRunning}
                  onClick={handleSwap}
                  title={gamesRunning ? "Close running games first" : undefined}
                >
                  {swapping ? (
                    <>
                      <span className="spinner" /> Swapping...
                    </>
                  ) : (
                    <>
                      <ArrowRightLeft size={14} /> Swap Configuration (
                      {selectedGames.length} game
                      {selectedGames.length > 1 ? "s" : ""},{" "}
                      {summary.targets.length} target
                      {summary.targets.length > 1 ? "s" : ""})
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Result Overlay */}
      {swapResult && (
        <div className="overlay" onClick={handleCloseResult}>
          <div className="result-card" onClick={(e) => e.stopPropagation()}>
            <div
              className={`result-icon ${swapResult.success ? "success" : "error"}`}
            >
              {swapResult.success ? (
                <CheckCircle2 size={32} />
              ) : (
                <XCircle size={32} />
              )}
            </div>
            <h3>{swapResult.success ? "Swap Complete!" : "Swap Failed"}</h3>
            <p>{swapResult.message}</p>

            {swapResult.details.length > 0 && (
              <div className="result-details">
                {swapResult.details.map((d, i) => (
                  <div
                    key={i}
                    className={`result-detail-item ${d.startsWith("Error:")
                      ? "error-item"
                      : d.startsWith("Warning:")
                        ? "warning-item"
                        : "success-item"
                      }`}
                  >
                    {d}
                  </div>
                ))}
              </div>
            )}

            <button className="btn btn-primary" onClick={handleCloseResult}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className="toast">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
