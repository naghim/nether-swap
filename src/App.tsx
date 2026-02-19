import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
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
} from "lucide-react";
import "./App.css";

// ─── Types ──────────────────────────────────────────────────

interface Profile {
  id: string;
  name: string;
  has_dota2: boolean;
  is_backup: boolean;
  path: string;
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
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedSource, setSelectedSource] = useState<{
    id: string;
    isBackup: boolean;
  } | null>(null);
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [summary, setSummary] = useState<SwapSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [swapResult, setSwapResult] = useState<SwapResult | null>(null);
  const [dotaRunning, setDotaRunning] = useState(false);
  const [setupStatus, setSetupStatus] = useState<
    "searching" | "found" | "error" | "idle"
  >("searching");
  const [setupError, setSetupError] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const dotaCheckRef = useRef<ReturnType<typeof setInterval>>();

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

  // Dota 2 process check
  useEffect(() => {
    if (screen !== "main") return;
    const check = async () => {
      try {
        const running = await invoke<boolean>("check_dota2_running");
        setDotaRunning(running);
      } catch {
        /* ignore */
      }
    };
    check();
    dotaCheckRef.current = setInterval(check, 5000);
    return () => clearInterval(dotaCheckRef.current);
  }, [screen]);

  // Load profiles when entering main screen
  const loadProfiles = useCallback(async () => {
    if (!userdataPath) return;
    try {
      const profs = await invoke<Profile[]>("get_profiles", { userdataPath });
      setProfiles(profs);
      setToast("Profiles refreshed");
      setTimeout(() => setToast(null), 2000);
    } catch {
      /* ignore */
    }
  }, [userdataPath]);

  useEffect(() => {
    if (screen === "main") {
      loadProfiles();
    }
  }, [screen, loadProfiles]);

  // Load summary when selection changes
  useEffect(() => {
    if (!selectedSource || selectedTargets.length === 0) {
      setSummary(null);
      return;
    }

    let cancelled = false;
    setLoadingSummary(true);

    (async () => {
      try {
        const s = await invoke<SwapSummary>("get_swap_summary", {
          userdataPath,
          sourceId: selectedSource.id,
          sourceIsBackup: selectedSource.isBackup,
          targetIds: selectedTargets,
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
  }, [selectedSource, selectedTargets, userdataPath]);

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
    // Source must have dota2 data
    if (!profile.has_dota2) return;
    const key = { id: profile.id, isBackup: profile.is_backup };
    if (
      selectedSource?.id === key.id &&
      selectedSource?.isBackup === key.isBackup
    ) {
      setSelectedSource(null);
      setSelectedTargets([]); // Clear targets when deselecting source
    } else {
      setSelectedSource(key);
      setSelectedTargets([]); // Clear targets when selecting new source
    }
  };

  const handleTargetToggle = (profile: Profile) => {
    // Can't select target before selecting a source
    if (!selectedSource) return;
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
  };

  const handleSwap = async () => {
    if (!selectedSource || selectedTargets.length === 0) return;
    setSwapping(true);
    try {
      const result = await invoke<SwapResult>("execute_swap", {
        userdataPath,
        sourceId: selectedSource.id,
        sourceIsBackup: selectedSource.isBackup,
        targetIds: selectedTargets,
      });
      setSwapResult(result);
      // Refresh profiles after swap
      await loadProfiles();
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

  const sourceProfiles = profiles.filter((p) => p.has_dota2);
  const targetProfiles = profiles.filter((p) => !p.is_backup);

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
              Dota 2 profile configuration manager. Swap your config between
              Steam accounts effortlessly.
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
            onClick={() => loadProfiles()}
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

      {/* Dota 2 Running Warning */}
      {dotaRunning && (
        <div className="dota-warning">
          <AlertTriangle size={16} />
          Dota 2 is currently running. Switching profiles while the game is open
          is not supported.
        </div>
      )}

      {/* Main Content */}
      <div className="main-content">
        <div className="description-text">
          Swap your Dota 2 config between Steam accounts effortlessly
        </div>
        <div className="panes-container">
          {/* Source Pane */}
          <div className="pane">
            <div className="pane-header">
              <span className="pane-title">Source</span>
              <span className="pane-badge">
                {sourceProfiles.length} available
              </span>
            </div>
            <div className="pane-list">
              {sourceProfiles.length === 0 ? (
                <div className="empty-state">
                  <Folder size={24} />
                  <p>No profiles with Dota 2 data found</p>
                </div>
              ) : (
                sourceProfiles.map((profile) => {
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
                          <span className="profile-tag">
                            <span className="dot green" />
                            Dota 2
                          </span>
                          {profile.is_backup && (
                            <span className="profile-tag">
                              <span className="dot orange" />
                              Backup
                            </span>
                          )}
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

          {/* Arrow Indicator */}
          <div className="pane-arrow">
            <ArrowRight size={24} />
          </div>

          {/* Target Pane */}
          <div className="pane">
            <div className="pane-header">
              <span className="pane-title">Targets</span>
              <span className="pane-badge">
                {selectedTargets.length} selected
              </span>
            </div>
            <div className="pane-list">
              {targetProfiles.length === 0 ? (
                <div className="empty-state">
                  <Folder size={24} />
                  <p>No target profiles found</p>
                </div>
              ) : (
                targetProfiles.map((profile) => {
                  const isSelected = selectedTargets.includes(profile.id);
                  const isSameAsSource =
                    !selectedSource?.isBackup &&
                    selectedSource?.id === profile.id;
                  const isDisabled = !selectedSource || isSameAsSource;
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
                          {profile.has_dota2 ? (
                            <span className="profile-tag">
                              <span className="dot green" />
                              Dota 2
                            </span>
                          ) : (
                            <span className="profile-tag">
                              <span className="dot red" />
                              No Dota 2
                            </span>
                          )}
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
                  disabled={swapping || dotaRunning}
                  onClick={handleSwap}
                  title={dotaRunning ? "Close Dota 2 first" : undefined}
                >
                  {swapping ? (
                    <>
                      <span className="spinner" /> Swapping...
                    </>
                  ) : (
                    <>
                      <ArrowRightLeft size={14} /> Swap Configuration (
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
                    className={`result-detail-item ${
                      d.startsWith("Error:")
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
