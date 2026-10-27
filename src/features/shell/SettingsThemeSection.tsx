import type { UiTheme } from "@/shared/anchor-api";
import { useThemeStore } from "./themeStore";

const THEME_OPTIONS: Array<{
  id: UiTheme;
  label: string;
  description: string;
}> = [
  {
    id: "light",
    label: "Light",
    description: "Warm paper panels for daytime reading.",
  },
  {
    id: "light-modern",
    label: "Light Modern",
    description: "VS Code Light Modern workbench and blue accents.",
  },
  {
    id: "dark",
    label: "Dark",
    description: "Neutral charcoal shell with warm sand accents.",
  },
  {
    id: "dark-modern",
    label: "Dark Modern",
    description: "VS Code Dark Modern workbench and blue accents.",
  },
];

/**
 * Settings → Theme: workbench color theme picker.
 */
export function SettingsThemeSection() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <section className="settings-section" aria-label="Theme">
      <h3 className="settings-section__title">Color theme</h3>
      <p className="settings-section__desc muted">
        Choose a workbench color theme. Applied immediately.
      </p>
      <div
        className="settings-theme"
        role="radiogroup"
        aria-label="Color theme"
        data-testid="settings-theme-picker"
      >
        {THEME_OPTIONS.map((opt) => {
          const active = theme === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={`settings-theme__card${active ? " is-active" : ""}`}
              onClick={() => void setTheme(opt.id)}
            >
              <span
                className={`settings-theme__swatch settings-theme__swatch--${opt.id}`}
                aria-hidden
              />
              <span className="settings-theme__meta">
                <span className="settings-theme__label">{opt.label}</span>
                <span className="settings-theme__hint">{opt.description}</span>
              </span>
              {active ? (
                <span className="settings-theme__check" aria-hidden>
                  ✓
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
