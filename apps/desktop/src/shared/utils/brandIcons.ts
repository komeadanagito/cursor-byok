//! Maps a recognized brand to the URL of its bundled monochrome logo.
import { modelBrand, providerBrand } from "./modelBrand";

const icons = import.meta.glob<string>("../assets/brand-icons/*.svg", { eager: true, query: "?url", import: "default" });

/** Logo URL of [brand], when one ships with the app. */
export function brandIconUrl(brand: string | null | undefined): string | null {
  return brand ? icons[`../assets/brand-icons/${brand}.svg`] ?? null : null;
}

/** A configured model's logo: its maker's by name, else its provider's by address. */
export function modelLogo(model: { model_id: string; base_url: string }): string | null {
  return brandIconUrl(modelBrand(model.model_id) ?? providerBrand(model.base_url));
}
