import Image from "next/image";
import React, { useEffect, useMemo, useState } from "react";

import movingImage from "@/app/services/avatar/moving.jpg";
import stillImage from "@/app/services/avatar/still.jpg";

interface RobotAvatarProps {
  isSpeaking?: boolean;
  state?: "idle" | "listening" | "thinking" | "speaking";
  toggleSpeed?: number;
  /** Rendered width/height in px. The side panel uses a compact size. */
  size?: number;
}

export const RobotAvatar: React.FC<RobotAvatarProps> = ({
  isSpeaking = false,
  state = "idle",
  toggleSpeed = 200,
  size = 210,
}) => {
  const [currentImage, setCurrentImage] = useState<"moving" | "still">("moving");

  const stateLabel = useMemo(() => {
    switch (state) {
      case "listening":
        return "Listening";
      case "thinking":
        return "Thinking";
      case "speaking":
        return "Speaking";
      default:
        return "Idle";
    }
  }, [state]);

  // Toggle between images when speaking
  useEffect(() => {
    if (state === "speaking") {
      const interval = setInterval(() => {
        setCurrentImage((prev) => (prev === "still" ? "moving" : "still"));
      }, toggleSpeed);

      return () => clearInterval(interval);
    }

    // When not speaking, always show moving image
    setCurrentImage("moving");
  }, [state, toggleSpeed, isSpeaking]);

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        style={{
          width: `${size}px`,
          height: `${size}px`,
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background:
              state === "listening"
                ? "radial-gradient(circle at 50% 50%, rgba(59,130,246,0.35), transparent 60%)"
                : state === "thinking"
                  ? "radial-gradient(circle at 50% 50%, rgba(245,158,11,0.35), transparent 60%)"
                  : "radial-gradient(circle at 50% 50%, rgba(16,185,129,0.3), transparent 55%)",
            animation:
              state === "listening"
                ? "listeningPulse 1.4s ease-in-out infinite"
                : state === "thinking"
                  ? "thinkingSpin 4s linear infinite"
                  : state === "speaking"
                    ? "speakingPulse 0.9s ease-in-out infinite"
                    : "none",
          }}
        />

        <div
          style={{
            // Was hardcoded 200px, which overflowed the box once the side panel
            // started rendering the avatar at a smaller size.
            width: `${Math.round(size * 0.95)}px`,
            height: `${Math.round(size * 0.95)}px`,
            position: "relative",
            borderRadius: "50%",
            background:
              state === "speaking"
                ? "linear-gradient(135deg, #0ea5e9, #10b981)"
                : state === "listening"
                  ? "linear-gradient(135deg, #2563eb, #22d3ee)"
                  : state === "thinking"
                    ? "linear-gradient(135deg, #f59e0b, #fcd34d)"
                    : "linear-gradient(135deg, #6b7280, #94a3b8)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto",
            transition: `all ${toggleSpeed}ms ease-in-out`,
            boxShadow:
              state === "speaking"
                ? "0 0 24px rgba(16, 185, 129, 0.45), 0 0 8px rgba(14,165,233,0.5)"
                : state === "listening"
                  ? "0 0 20px rgba(59,130,246,0.35)"
                  : state === "thinking"
                    ? "0 0 20px rgba(245,158,11,0.35)"
                    : "none",
            overflow: "hidden",
          }}
        >
          {/* Both frames stay mounted and we cross-fade opacity. Swapping the
              `src` of a single next/image instead meant a fresh decode on every
              toggle, which at this interval never completed -- so the avatar
              sat on one frame and looked frozen. */}
          {(["moving", "still"] as const).map((frame) => (
            <Image
              key={frame}
              src={frame === "still" ? stillImage : movingImage}
              alt=""
              width={200}
              height={200}
              priority
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                borderRadius: "50%",
                opacity: currentImage === frame ? 1 : 0,
                transition: `opacity ${Math.round(toggleSpeed / 2)}ms linear`,
              }}
            />
          ))}
        </div>
      </div>

      <div className="text-center">
        <div className="text-xs uppercase tracking-[0.2em] text-slate-500">State</div>
        <div className="text-lg font-semibold text-slate-800">{stateLabel}</div>
      </div>

      <style jsx>{`
        @keyframes listeningPulse {
          0% {
            transform: scale(0.95);
            opacity: 0.6;
          }
          50% {
            transform: scale(1.05);
            opacity: 1;
          }
          100% {
            transform: scale(0.95);
            opacity: 0.6;
          }
        }

        @keyframes thinkingSpin {
          0% {
            transform: rotate(0deg);
          }
          100% {
            transform: rotate(360deg);
          }
        }

        @keyframes speakingPulse {
          0%,
          100% {
            transform: scale(1);
            opacity: 0.85;
          }
          50% {
            transform: scale(1.1);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
};

