import { Icon as IconifyIcon, type IconifyIcon as IconData } from "@iconify/react/offline";
import styles from "./Icon.module.scss";

export interface IconProps {
  icon?: IconData;
  src?: string;
  /** A monochrome SVG drawn in the surrounding text color; `icon` shows in its place when absent. */
  mask?: string | null;
  size?: `${number}em`;
  className?: string;
}

export function Icon({ icon, src, mask, size = "1em", className }: IconProps) {
  return <div
    aria-hidden="true"
    className={[styles.icon, className].filter(Boolean).join(" ")}
    style={{ height: size, width: size }}
  >
    {mask ? <span className={styles.mask} style={{ maskImage: `url("${mask}")` }} /> : src ? <img alt="" src={src} /> : icon ? <IconifyIcon height="100%" icon={icon} width="100%" /> : null}
  </div>;
}
