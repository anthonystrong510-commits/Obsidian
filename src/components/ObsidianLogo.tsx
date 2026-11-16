import { useState } from 'react';

interface ObsidianLogoProps {
  size?: number;
  className?: string;
}

export function ObsidianLogo({ size = 32, className = '' }: ObsidianLogoProps) {
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <span
      style={{ width: size, height: size }}
      className={`inline-flex items-center justify-center rounded-lg overflow-hidden border border-white/15 bg-[#090B0F] shrink-0 ${className}`}
    >
      {!imgFailed ? (
        <img
          src="/src/assets/images/obsidian_brand_logo_1794858382454.jpg"
          alt="Obsidian Vault emblem"
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <svg viewBox="0 0 64 64" fill="none" className="w-full h-full">
          <rect width="64" height="64" fill="#090B0F" />
          <path
            d="M32 8L53 20V44L32 56L11 44V20L32 8Z"
            fill="#11151C"
            stroke="#334155"
            strokeWidth="2"
          />
          <path d="M32 11L34 15V49L32 53L30 49V15L32 11Z" fill="#10B981" />
          <path d="M21 23H25L32 36L39 23H43L32 44L21 23Z" fill="#34D399" />
        </svg>
      )}
    </span>
  );
}
