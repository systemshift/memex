import {
  Calendar,
  Search,
  Network,
  Settings,
  Plus,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
} from "../icons";

type Props = {
  onToday: () => void;
  onNew: () => void;
  onSearch: () => void;
  onSettings: () => void;
  onCommand: () => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
};

/**
 * Left activity rail. Compact vertical column of icon buttons that
 * expose the app's global actions: navigate time-wise, create, find,
 * configure. Keyboard shortcuts stay the primary interaction — the
 * ribbon is for discovery and muscle memory.
 */
export function Ribbon({
  onToday,
  onNew,
  onSearch,
  onSettings,
  onCommand,
  onBack,
  onForward,
  canBack,
  canForward,
}: Props) {
  return (
    <nav className="ribbon" aria-label="Activity bar">
      <div className="ribbon-group">
        <RibbonButton
          label="Back (⌘[)"
          onClick={onBack}
          disabled={!canBack}
          icon={<ChevronLeft size={18} />}
        />
        <RibbonButton
          label="Forward (⌘])"
          onClick={onForward}
          disabled={!canForward}
          icon={<ChevronRight size={18} />}
        />
      </div>

      <div className="ribbon-group">
        <RibbonButton
          label="Today's note (⌘D)"
          onClick={onToday}
          icon={<Calendar size={18} />}
        />
        <RibbonButton
          label="New node (⌘N)"
          onClick={onNew}
          icon={<Plus size={18} />}
        />
        <RibbonButton
          label="Search (⌘⇧F)"
          onClick={onSearch}
          icon={<Search size={18} />}
        />
        <RibbonButton
          label="Command palette (⌘K)"
          onClick={onCommand}
          icon={<MessageSquare size={18} />}
        />
      </div>

      <div className="ribbon-spacer" />

      <div className="ribbon-group">
        <RibbonButton
          label="Graph view (coming soon)"
          onClick={() => {}}
          disabled
          icon={<Network size={18} />}
        />
        <RibbonButton
          label="Settings"
          onClick={onSettings}
          icon={<Settings size={18} />}
        />
      </div>
    </nav>
  );
}

function RibbonButton({
  label,
  onClick,
  icon,
  disabled,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      className="ribbon-btn"
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={disabled}
    >
      {icon}
    </button>
  );
}
