export const APPLE_IAP_PRODUCTS = Object.freeze({
  "com.disability.disabilitymn.plan.monthly": "monthly",
  "com.disability.disabilitymn.plan.annual": "annual",
  "com.disability.disabilitymn.plan.quarterly": "quarterly",
  "com.disability.disabilitymn.plan.premium": "premium",
});

export const PLAN_TO_APPLE_PRODUCT = Object.freeze(
  Object.fromEntries(
    Object.entries(APPLE_IAP_PRODUCTS).map(([productId, planKey]) => [planKey, productId])
  )
);

export const resolvePlanKeyFromAppleProduct = (productId) => {
  const normalized = String(productId || "").trim().toLowerCase();
  return APPLE_IAP_PRODUCTS[normalized] || "";
};
