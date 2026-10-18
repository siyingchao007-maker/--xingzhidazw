"use strict";

const STANDARD_BRAND_SCHEMA = "xingzhi-standard-vault/v1";
const LEGACY_XINGZHI_LOGO_ICON = "xingzhi-pathmark";
const XINGZHI_LOGO_ICON = "orbit";
const XINGZHI_BRAND_ASSET = "xingzhi-brand.png";
const STANDARD_BRAND_CONFIG = Object.freeze({
  schema: STANDARD_BRAND_SCHEMA,
  brand: XINGZHI_LOGO_ICON,
});
const STANDARD_BRAND_CLASS = "xz-standard-brand";


function isStandardBrandConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2
    && keys[0] === "brand"
    && keys[1] === "schema"
    && value.schema === STANDARD_BRAND_SCHEMA
    && [XINGZHI_LOGO_ICON, LEGACY_XINGZHI_LOGO_ICON].includes(value.brand);
}

module.exports = {
  LEGACY_XINGZHI_LOGO_ICON,
  STANDARD_BRAND_CLASS,
  STANDARD_BRAND_CONFIG,
  STANDARD_BRAND_SCHEMA,
  XINGZHI_BRAND_ASSET,
  XINGZHI_LOGO_ICON,
  isStandardBrandConfig,
};
