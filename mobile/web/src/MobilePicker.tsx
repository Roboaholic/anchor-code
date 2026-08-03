import { useEffect, useId, useState } from "react";

export interface MobilePickerOption {
  value: string;
  title: string;
  subtitle?: string;
  badge?: string;
}

export function MobilePicker({
  label,
  value,
  options,
  onChange,
  placeholder = "请选择",
  className = "",
}: {
  label: string;
  value: string;
  options: MobilePickerOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const reactId = useId();
  const historyId = `anchor-picker-${reactId}`;
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onPopState = () => setOpen(false);
    window.history.pushState({ ...window.history.state, anchorMobilePicker: historyId }, "");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [historyId, open]);

  const close = () => {
    if (window.history.state?.anchorMobilePicker === historyId) window.history.back();
    else setOpen(false);
  };

  return (
    <>
      <button type="button" className={`mobile-picker-trigger ${className}`.trim()} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        <span className="mobile-picker-trigger__copy">
          <small>{label}</small>
          <b>{selected?.title || placeholder}</b>
          {selected?.subtitle ? <em>{selected.subtitle}</em> : null}
        </span>
        {selected?.badge ? <span className="mobile-picker-trigger__badge">{selected.badge}</span> : null}
        <span className="mobile-picker-trigger__chevron">⌄</span>
      </button>
      {open ? (
        <div className="mobile-picker-backdrop" role="presentation" onClick={close}>
          <section className="mobile-picker-sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(event) => event.stopPropagation()}>
            <div className="sheet__handle" />
            <header><div><span className="eyebrow">选择</span><h3>{label}</h3></div><button type="button" className="icon-button" onClick={close}>×</button></header>
            <div className="mobile-picker-options">
              {options.map((option) => (
                <button type="button" className={option.value === value ? "is-selected" : ""} key={option.value} onClick={() => { onChange(option.value); close(); }}>
                  <span>{option.badge ? <i>{option.badge}</i> : null}<span><b>{option.title}</b>{option.subtitle ? <small>{option.subtitle}</small> : null}</span></span>
                  <em>{option.value === value ? "✓" : ""}</em>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
