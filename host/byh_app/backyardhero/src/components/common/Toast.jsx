import { useEffect, useState } from 'react';
import { FaX } from 'react-icons/fa6';

const Toast = ({ message, onDismiss, duration = 30000 }) => {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(() => onDismiss(), 300); // Wait for fade out animation
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  const handleDismiss = () => {
    setIsVisible(false);
    setTimeout(() => onDismiss(), 300);
  };

  if (!isVisible) return null;

  return (
    <div
      className={`bg-red-900 border border-red-500 text-red-100 px-4 py-3 rounded-lg shadow-lg mb-2 flex items-center justify-between min-w-[300px] max-w-[500px] transition-opacity duration-300 ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
      style={{ zIndex: 9999 }}
    >
      <span className="flex-1 text-sm">{message}</span>
      <button
        onClick={handleDismiss}
        className="ml-4 text-red-300 hover:text-red-100 transition-colors"
        aria-label="Dismiss"
      >
        <FaX size={14} />
      </button>
    </div>
  );
};

export default Toast;

