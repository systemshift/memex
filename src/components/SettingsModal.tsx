import { useEffect, useState } from "react";
import { Settings, X, Sun, Moon, Monitor } from "../icons";

type Theme = "system" | "light" | "dark";

type Props = {
  open: boolean;
  onClose: () => void;
  mountPath: string;
  model: string;
  apiKeyPresent: boolean;
};

const THEME_KEY = "memex.theme";

/**
 * Settings shell. For v0.6 it's a read-only view of what's configured
 * plus a working theme toggle (system / light / dark). Real settings
 * editing (provider choice, model pick, hotkey remap) comes once the
 * single-user shape stabilizes.
 */
export function SettingsModal({ open, onClose, mountPath, model, apiKeyPresent }: Props) {
  const [theme, setTheme] = useState<Theme>(() => {
    return (localStorage.getItem(THEME_KEY) as Theme) || "system";
  });

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <Settings size={16} />
          <span className="modal-title">Settings</span>
          <div className="modal-spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <section className="settings-section">
          <h3>Appearance</h3>
          <div className="theme-row" role="radiogroup" aria-label="Theme">
            <ThemeOption label="System" value="system" current={theme} onPick={setTheme} icon={<Monitor size={14} />} />
            <ThemeOption label="Light" value="light" current={theme} onPick={setTheme} icon={<Sun size={14} />} />
            <ThemeOption label="Dark" value="dark" current={theme} onPick={setTheme} icon={<Moon size={14} />} />
          </div>
        </section>

        <section className="settings-section">
          <h3>Storage</h3>
          <dl className="kv">
            <dt>Mount path</dt>
            <dd><code>{mountPath}</code></dd>
          </dl>
        </section>

        <section className="settings-section">
          <h3>Assistant</h3>
          <dl className="kv">
            <dt>Model</dt>
            <dd><code>{model}</code></dd>
            <dt>API key</dt>
            <dd>
              {apiKeyPresent ? (
                <span className="pill ok">OPENAI_API_KEY present</span>
              ) : (
                <span className="pill warn">OPENAI_API_KEY not set</span>
              )}
            </dd>
          </dl>
          <p className="settings-note">
            The model and provider are currently fixed. Provider picker and
            per-session model selection land in a later settings pass.
          </p>
        </section>
      </div>
    </div>
  );
}

function ThemeOption({
  label,
  value,
  current,
  onPick,
  icon,
}: {
  label: string;
  value: Theme;
  current: Theme;
  onPick: (v: Theme) => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      role="radio"
      aria-checked={value === current}
      className={`theme-option ${value === current ? "active" : ""}`}
      onClick={() => onPick(value)}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.removeAttribute("data-theme");
  if (theme === "light" || theme === "dark") {
    root.setAttribute("data-theme", theme);
  }
}
