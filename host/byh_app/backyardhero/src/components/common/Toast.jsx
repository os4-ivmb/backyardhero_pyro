import { useEffect, useState } from "react";
import { FaX } from "react-icons/fa6";
import { cn } from "@/design";

const Toast = ({ message, onDismiss, duration = 30000 }) => {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(), 300);
    }, duration);
    return () => clearTimeout(t);
  }, [duration, onDismiss]);

  const handleDismiss = () => {
    setVisible(false);
    setTimeout(() => onDismiss(), 300);
  };

  if (!visible) return null;

  return (
    <div
      role="status"
      className={cn(
        "bg-danger-bg border border-danger/60 text-danger-fg",
        "px-3 py-2 rounded-md shadow-e3 flex items-start gap-3",
        "min-w-[280px] max-w-[480px] transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      <span className="flex-1 text-sm leading-snug break-words">{message}</span>
      <button
        onClick={handleDismiss}
        className="text-fg-muted hover:text-fg-primary transition-colors shrink-0 mt-0.5"
        aria-label="Dismiss"
      >
        <FaX size={12} aria-hidden />
      </button>
    </div>
  );
};

export default Toast;
