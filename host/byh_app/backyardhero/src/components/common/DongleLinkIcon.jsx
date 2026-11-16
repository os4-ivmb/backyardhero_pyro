import React from "react";
import { MdPower, MdWifi } from "react-icons/md";
import { cn } from "@/design";
import { DONGLE_LINK_WIRELESS } from "@/util/dongleLink";

const TONE_TEXT = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  armed: "text-armed",
  live: "text-live",
  accent: "text-accent",
  neutral: "text-fg-disabled",
};

// Plug (USB serial) or Wi-Fi (Omni hub WebSocket) glyph for the dongle link.
// Drop-in for the status Dot: same tone palette, so the icon still carries
// the health colour while also saying how the dongle is attached.
export default function DongleLinkIcon({ link, tone, pulse = false, className }) {
  const wireless = link === DONGLE_LINK_WIRELESS;
  const Icon = wireless ? MdWifi : MdPower;
  return (
    <Icon
      className={cn(
        "shrink-0 text-sm",
        tone ? TONE_TEXT[tone] || TONE_TEXT.neutral : null,
        pulse && "animate-livePulse",
        className
      )}
      aria-label={wireless ? "Wireless dongle link" : "USB dongle link"}
      role="img"
    />
  );
}
