//! Pieces shared by the provider list and provider pages: icons, the breadcrumb title, and a model row.
import type { ReactNode } from "react";
import magpieLogo from "../../shared/assets/provider-icons/magpie.png";
import { Icon } from "../../shared/ui/Icon";
import { checkIcon, chevronRightIcon, providerIcon } from "../../shared/ui/icons";
import { brandIconUrl } from "../../shared/utils/brandIcons";
import { modelBrand } from "../../shared/utils/modelBrand";
import { MAGPIE_PROVIDER, type CursorProvider } from "./cursorProviders";
import styles from "./Providers.module.scss";

export function contextLabel(tokens: number) {
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1_000)}K`;
}

export function ProviderIcon({ provider, size = "1.15em" }: { provider: CursorProvider | typeof MAGPIE_PROVIDER; size?: `${number}em` }) {
  if (provider === MAGPIE_PROVIDER) return <Icon className={`${styles.logo} ${styles.magpieLogo}`} src={magpieLogo} size={size} />;
  if (provider.kind === "plugin") return <Icon className={styles.logo} src={provider.iconSrc} size={size} />;
  return <Icon className={provider.brand === "claude" ? styles.claudeLogo : styles.logo} mask={brandIconUrl(provider.brand)} icon={providerIcon} size={size} />;
}

/** The page title of an open provider: the way back to the list, then the provider itself. */
export function ProviderTitle({ icon, name, detail, onBack }: { icon: ReactNode; name: string; detail?: string; onBack: () => void }) {
  return <span className={styles.crumb}>
    <button type="button" className={styles.crumbBack} onClick={onBack}>Cursor</button>
    <Icon className={styles.crumbSeparator} icon={chevronRightIcon} size="0.8em" />
    {icon}
    <span className={styles.crumbName}>{name}</span>
    {detail && <span className={styles.crumbDetail}>{detail}</span>}
  </span>;
}

export function ModelCheck({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <label className={styles.check}>
    <input type="checkbox" checked={checked} aria-label={label} onChange={event => onChange(event.target.checked)} />
    <span aria-hidden>{checked && <Icon icon={checkIcon} size="0.9em" />}</span>
  </label>;
}

/** One model: its maker's logo (else [fallback]), name, id and traits; [leading] and [trailing] hold its controls. */
export function ModelRow({ modelId, name, fallback, badges = [], context, leading, trailing, muted, dataId }: {
  modelId: string;
  name: string;
  fallback: ReactNode;
  badges?: string[];
  context?: number | null;
  leading?: ReactNode;
  trailing?: ReactNode;
  muted?: boolean;
  dataId?: string;
}) {
  const logo = brandIconUrl(modelBrand(modelId));
  return <div className={[styles.row, muted && styles.muted].filter(Boolean).join(" ")} data-id={dataId}>
    {leading}
    {logo ? <Icon className={styles.logo} mask={logo} size="1.15em" /> : fallback}
    <div className={styles.text}>
      <div className={styles.line}>
        <span className={styles.name}>{name}</span>
        {badges.map(badge => <span key={badge} className={styles.badge}>{badge}</span>)}
      </div>
      {name !== modelId && <span className={`${styles.detail} ${styles.mono}`}>{modelId}</span>}
    </div>
    {context !== undefined && <span className={styles.context}>{context ? contextLabel(context) : "—"}</span>}
    {trailing}
  </div>;
}
