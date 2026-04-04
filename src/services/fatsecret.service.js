import httpStatus from "http-status";
import AppError from "../utils/AppError.js";

const getConfig = () => ({
  tokenUrl: String(process.env.FATSECRET_TOKEN_URL || "").trim() || "https://oauth.fatsecret.com/connect/token",
  apiBaseUrl: String(process.env.FATSECRET_API_BASE_URL || "").trim() || "https://platform.fatsecret.com/rest/",
  clientId: String(process.env.FATSECRET_CLIENT_ID || "").trim(),
  clientSecret: String(process.env.FATSECRET_CLIENT_SECRET || "").trim(),
  scope: String(process.env.FATSECRET_SCOPE || "").trim() || "basic",
  timeoutMs: Math.max(Number(process.env.FATSECRET_TIMEOUT_MS || 12000), 1000),
  searchCacheTtlMs: Math.max(Number(process.env.FATSECRET_SEARCH_CACHE_TTL_MS || 5 * 60 * 1000), 30000),
  detailCacheTtlMs: Math.max(Number(process.env.FATSECRET_DETAIL_CACHE_TTL_MS || 24 * 60 * 60 * 1000), 60000),
  tokenSkewMs: Math.max(Number(process.env.FATSECRET_TOKEN_SKEW_MS || 2 * 60 * 1000), 10000),
  maxFinalResults: Math.min(Math.max(Number(process.env.FATSECRET_MAX_FINAL_RESULTS || 30), 10), 50),
  detailConcurrency: Math.min(Math.max(Number(process.env.FATSECRET_DETAIL_CONCURRENCY || 4), 1), 8),
});

export const FATSECRET_PUBLIC_ID_OFFSET = 5000000000;

const tokenState = { value: "", expiresAt: 0, pending: null };
const searchCache = new Map();
const detailCache = new Map();
const summaryCache = new Map();

const NON_CORE_TOKENS = new Set([
  "added",
  "baby",
  "drained",
  "extra",
  "fresh",
  "fuji",
  "gala",
  "golden",
  "granny",
  "honeycrisp",
  "jumbo",
  "large",
  "lady",
  "medium",
  "mini",
  "pink",
  "peeled",
  "red",
  "seedless",
  "skin",
  "sliced",
  "small",
  "smith",
  "sugar",
  "unpeeled",
  "without",
  "with",
]);
const QUERY_STOPWORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"]);
const RESTAURANT_NOISE =
  /\b(mcdonalds?|burger king|starbucks|subway|kfc|dominos?|pizza hut|wendys?|taco bell|dunkin|chipotle|arbys?|restaurant|cafe|whole foods|trader joe'?s|costco|walmart|target|tesco)\b/i;
const VARIANTS = [
  { key: "hard-boiled", label: "Hard-Boiled", regex: /\bhard[-\s]?boiled\b/i },
  { key: "boiled", label: "Boiled", regex: /\bboiled\b/i },
  { key: "fried", label: "Fried", regex: /\b(?:fried|pan[-\s]?fried|stir[-\s]?fried)\b/i },
  { key: "scrambled", label: "Scrambled", regex: /\bscrambled\b/i },
  { key: "poached", label: "Poached", regex: /\bpoached\b/i },
  { key: "grilled", label: "Grilled", regex: /\bgrilled\b/i },
  { key: "roasted", label: "Roasted", regex: /\broasted\b/i },
  { key: "baked", label: "Baked", regex: /\bbaked\b/i },
  { key: "steamed", label: "Steamed", regex: /\bsteamed\b/i },
  { key: "raw", label: "Raw", regex: /\braw\b/i },
];

const str = (value) => (value === null || value === undefined ? "" : String(value).trim());
const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const round = (value, decimals = 1) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};
const arr = (value) => (Array.isArray(value) ? value : value && typeof value === "object" ? [value] : []);
const norm = (value) =>
  str(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[(){}[\],|/\\]+/g, " ")
    .replace(/[^a-z0-9.\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const words = (value) => norm(value).replace(/-/g, " ").split(" ").filter(Boolean);
const title = (value) =>
  str(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
const singularizeToken = (token) => {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("oes")) return token.slice(0, -2);
  if (token.length > 4 && /(ches|shes|xes|zes|ses)$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
};
const readCache = (cache, key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};
const writeCache = (cache, key, value, ttlMs) => {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
};
const metricToGrams = (amount, unit) => {
  const value = num(amount);
  const normalizedUnit = norm(unit);
  if (!value || value <= 0) return null;
  if (["g", "gram", "grams", "ml"].includes(normalizedUnit)) return value;
  if (["oz", "ounce", "ounces"].includes(normalizedUnit)) return value * 28.3495;
  return null;
};
const detectVariant = (value) => VARIANTS.find((variant) => variant.regex.test(norm(value))) || null;
const withoutVariant = (value) => {
  let cleaned = norm(value);
  for (const variant of VARIANTS) cleaned = cleaned.replace(variant.regex, " ");
  return cleaned.replace(/\s+/g, " ").trim();
};
const encodeFoodId = (foodId) => FATSECRET_PUBLIC_ID_OFFSET + Math.floor(num(foodId) || 0);
const decodeFoodId = (publicId) => {
  const value = Math.floor(num(publicId) || 0);
  if (value <= 0) throw new AppError("fdcId must be a valid FatSecret food id.", httpStatus.BAD_REQUEST);
  return value >= FATSECRET_PUBLIC_ID_OFFSET ? value - FATSECRET_PUBLIC_ID_OFFSET : value;
};
export const isFatSecretPublicFoodId = (foodId) => (num(foodId) || 0) >= FATSECRET_PUBLIC_ID_OFFSET;

const upstreamErrorMessage = (payload) => {
  if (!payload) return "";
  if (typeof payload === "string") return payload.trim();
  if (typeof payload.error === "string") return payload.error.trim();
  if (payload.error && typeof payload.error === "object") {
    return [str(payload.error.code), str(payload.error.message || payload.error.description)].filter(Boolean).join(" - ");
  }
  return [str(payload.code), str(payload.message || payload.description || payload.error_description)]
    .filter(Boolean)
    .join(" - ");
};

const fetchJson = async (url, options, label) => {
  const controller = new AbortController();
  const { timeoutMs } = getConfig();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const contentType = str(response.headers.get("content-type")).toLowerCase();
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();

    if (!response.ok || (payload && typeof payload === "object" && payload.error)) {
      const message = upstreamErrorMessage(payload);
      throw new AppError(
        `${label} failed${response.ok ? "" : ` (${response.status})`}${message ? `: ${message}` : ""}`,
        httpStatus.BAD_GATEWAY
      );
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AppError(`${label} timed out.`, httpStatus.GATEWAY_TIMEOUT);
    }
    if (error instanceof AppError) throw error;
    throw new AppError(`${label} error: ${error.message}`, httpStatus.BAD_GATEWAY);
  } finally {
    clearTimeout(timeout);
  }
};

const requireCredentials = () => {
  const { clientId, clientSecret } = getConfig();
  if (!clientId || !clientSecret) {
    throw new AppError(
      "FatSecret credentials are missing. Set FATSECRET_CLIENT_ID and FATSECRET_CLIENT_SECRET.",
      httpStatus.INTERNAL_SERVER_ERROR
    );
  }
};

const requestAccessToken = async () => {
  requireCredentials();
  const { clientId, clientSecret, scope, tokenUrl } = getConfig();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials", scope });
  const payload = await fetchJson(
    tokenUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    "FatSecret token request"
  );

  const accessToken = str(payload?.access_token);
  const expiresInSeconds = Math.max(num(payload?.expires_in) || 0, 60);
  if (!accessToken) {
    throw new AppError("FatSecret token response did not include an access token.", httpStatus.BAD_GATEWAY);
  }

  tokenState.value = accessToken;
  tokenState.expiresAt = Date.now() + expiresInSeconds * 1000;
  return accessToken;
};

const getAccessToken = async () => {
  const { tokenSkewMs } = getConfig();
  if (tokenState.value && tokenState.expiresAt - tokenSkewMs > Date.now()) {
    return tokenState.value;
  }

  if (!tokenState.pending) {
    tokenState.pending = requestAccessToken().finally(() => {
      tokenState.pending = null;
    });
  }

  return tokenState.pending;
};

const apiUrl = (path, params = {}) => {
  const { apiBaseUrl } = getConfig();
  const url = new URL(path.replace(/^\//, ""), apiBaseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  url.searchParams.set("format", "json");
  return url.toString();
};

const fatsecretGet = async (path, params, label) => {
  const accessToken = await getAccessToken();
  return fetchJson(
    apiUrl(path, params),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    label
  );
};

const buildQueryContext = (query) => {
  const normalizedQuery = norm(query);
  const variant = detectVariant(normalizedQuery);
  const baseTokens = words(withoutVariant(normalizedQuery))
    .map(singularizeToken)
    .filter((token) => !QUERY_STOPWORDS.has(token));
  const finalTokens = baseTokens.length > 0 ? baseTokens : words(normalizedQuery);
  const basePhrase = finalTokens.join(" ").trim();
  return {
    normalizedQuery,
    variant,
    baseTokens: finalTokens,
    basePhrase,
    baseLabel: title(basePhrase || normalizedQuery),
  };
};

const inferBasePhrase = (foodName, queryContext = null) => {
  const baseTokens = words(withoutVariant(foodName))
    .map(singularizeToken)
    .filter((token) => !QUERY_STOPWORDS.has(token) && !NON_CORE_TOKENS.has(token));
  if (queryContext?.baseTokens?.length) {
    const tokenSet = new Set(baseTokens);
    if (
      queryContext.baseTokens.every((token) => tokenSet.has(token)) &&
      baseTokens.length <= queryContext.baseTokens.length + 1
    ) {
      return queryContext.basePhrase;
    }
  }
  return baseTokens.slice(0, 3).join(" ").trim();
};

const canonicalName = (foodName, queryContext = null) => {
  const variant = detectVariant(foodName);
  const baseLabel = title(inferBasePhrase(foodName, queryContext) || norm(foodName));
  return variant ? `${variant.label} ${baseLabel}`.trim() : baseLabel;
};

const rawSearchScore = (food, queryContext) => {
  const normalizedName = norm(food.foodName);
  const isExact = normalizedName === queryContext.normalizedQuery;
  const startsWithQuery = normalizedName.startsWith(queryContext.normalizedQuery);
  const baseMatches = queryContext.baseTokens.every((token) => words(normalizedName).includes(token));
  const variant = detectVariant(normalizedName);

  let score = 0;
  if (isExact) score += 1200;
  if (startsWithQuery) score += 300;
  if (baseMatches) score += 180;
  if (inferBasePhrase(food.foodName, queryContext) === queryContext.basePhrase) score += 160;
  score += variant ? (queryContext.variant && variant.key === queryContext.variant.key ? 100 : 60) : 120;
  score -= Math.min(normalizedName.length, 120) / 12;
  return score;
};

const passesSimpleQueryFilter = (food, queryContext) => {
  if (queryContext.baseTokens.length !== 1) return true;

  const variant = detectVariant(food.foodName);
  const tokenCount = words(food.foodName).length;
  const startsWithQuery = norm(food.foodName).startsWith(queryContext.normalizedQuery);
  const basePhrase = inferBasePhrase(food.foodName, queryContext);

  if (basePhrase === queryContext.basePhrase) return true;
  if (variant && basePhrase === queryContext.basePhrase) return true;
  if (!startsWithQuery) return false;
  return tokenCount <= 2;
};

const parseSnippetNumber = (text, label) => {
  const match = str(text).match(new RegExp(`${label}:\\s*([0-9]+(?:\\.[0-9]+)?)`, "i"));
  return match ? Number(match[1]) : null;
};

const parseSearchSnippet = (foodDescription) => {
  const description = str(foodDescription);
  const basis = str(description.match(/per\s+([^|-]+?)(?:\s*[-|]|$)/i)?.[1]);
  const metric = basis.match(/([0-9]+(?:\.[0-9]+)?)\s*(g|ml|oz)\b/i);
  return {
    basis,
    gramWeight: metric ? metricToGrams(Number(metric[1]), metric[2]) : null,
    metricUnit: metric ? norm(metric[2]) : "g",
    nutrients: {
      caloriesKcal: parseSnippetNumber(description, "Calories"),
      proteinG: parseSnippetNumber(description, "Protein"),
      carbsG: parseSnippetNumber(description, "Carbs"),
      fatG: parseSnippetNumber(description, "Fat"),
      fiberG: parseSnippetNumber(description, "Fiber"),
      sugarG: parseSnippetNumber(description, "Sugar"),
    },
  };
};

const completeNutrients = (nutrients = {}) => ({
  caloriesKcal: num(nutrients.caloriesKcal) ?? 0,
  proteinG: num(nutrients.proteinG) ?? 0,
  carbsG: num(nutrients.carbsG) ?? 0,
  fatG: num(nutrients.fatG) ?? 0,
  fiberG: num(nutrients.fiberG) ?? 0,
  sugarG: num(nutrients.sugarG) ?? 0,
});

const nutrientCompleteness = (nutrients = {}) =>
  ["caloriesKcal", "proteinG", "carbsG", "fatG", "fiberG", "sugarG"].reduce(
    (total, key) => total + (num(nutrients[key]) !== null ? 1 : 0),
    0
  );

const upsertPortion = (options, portion) => {
  const gramWeight = round(num(portion.gramWeight) || 0, 1);
  const label = str(portion.label);
  if (!label || gramWeight <= 0) return;
  const key = `${label.toLowerCase()}|${gramWeight}`;
  if (options.some((item) => `${item.label.toLowerCase()}|${item.gramWeight}` === key)) return;
  options.push({
    id: portion.id ?? null,
    label,
    amount: num(portion.amount) || 1,
    gramWeight,
    estimated: Boolean(portion.estimated),
  });
};

const parseServing = (serving) => ({
  servingId: num(serving.serving_id),
  servingDescription: str(serving.serving_description),
  measurementDescription: str(serving.measurement_description),
  metricUnit: norm(serving.metric_serving_unit) || "g",
  gramWeight: metricToGrams(serving.metric_serving_amount, serving.metric_serving_unit),
  numberOfUnits: num(serving.number_of_units) || 1,
  caloriesKcal: num(serving.calories),
  proteinG: num(serving.protein),
  carbsG: num(serving.carbohydrate),
  fatG: num(serving.fat),
  fiberG: num(serving.fiber),
  sugarG: num(serving.sugar),
  isDefault: str(serving.is_default) === "1",
});

const per100FromServing = (serving) => {
  if (!serving?.gramWeight || serving.gramWeight <= 0) return null;
  const factor = 100 / serving.gramWeight;
  return {
    nutrients: {
      caloriesKcal: round((num(serving.caloriesKcal) || 0) * factor, 1),
      proteinG: round((num(serving.proteinG) || 0) * factor, 1),
      carbsG: round((num(serving.carbsG) || 0) * factor, 1),
      fatG: round((num(serving.fatG) || 0) * factor, 1),
      fiberG: round((num(serving.fiberG) || 0) * factor, 1),
      sugarG: round((num(serving.sugarG) || 0) * factor, 1),
    },
    exact: Math.abs(serving.gramWeight - 100) < 0.01,
    metricUnit: serving.metricUnit || "g",
  };
};

const cleanServingLabel = (serving) => {
  if (Math.abs((num(serving.gramWeight) || 0) - 100) < 0.01) {
    return serving.metricUnit === "ml" ? "100 ml serving" : "100 g serving";
  }

  let label = str(serving.measurementDescription || serving.servingDescription);
  label = label.replace(/^(?:[0-9]+(?:\.[0-9]+)?|[0-9]+\/[0-9]+)\s*/i, "").trim();
  if (!label || label.toLowerCase() === "g") {
    return `${round(num(serving.gramWeight) || 0, 0)} g serving`;
  }
  return label.charAt(0).toUpperCase() + label.slice(1);
};

const stripMeta = (food) => {
  const publicFood = { ...food };
  delete publicFood._meta;
  return publicFood;
};

const saveSummary = (food) => {
  const { detailCacheTtlMs } = getConfig();
  return writeCache(summaryCache, String(food.fdcId), stripMeta(food), detailCacheTtlMs);
};

const parseSearchFood = (food) => ({
  foodId: num(food.food_id),
  foodName: str(food.food_name),
  brandName: str(food.brand_name),
  foodType: str(food.food_type),
  foodUrl: str(food.food_url),
  foodDescription: str(food.food_description),
});

const fetchSearchSource = async (query) => {
  const { maxFinalResults, searchCacheTtlMs } = getConfig();
  const key = `search-source:${norm(query)}`;
  const cached = readCache(searchCache, key);
  if (cached) return cached;

  const response = await fatsecretGet(
    "foods/search/v1",
    { search_expression: query, page_number: 0, max_results: Math.min(maxFinalResults * 4, 50) },
    "FatSecret foods.search"
  );
  const payload = {
    totalResults: num(response?.foods?.total_results) || 0,
    foods: arr(response?.foods?.food).map(parseSearchFood).filter((food) => food.foodId && food.foodName),
  };
  return writeCache(searchCache, key, payload, searchCacheTtlMs);
};

const fetchFoodDetail = async (publicFoodId) => {
  const { detailCacheTtlMs } = getConfig();
  const rawFoodId = decodeFoodId(publicFoodId);
  const key = `detail:${rawFoodId}`;
  const cached = readCache(detailCache, key);
  if (cached) return cached;

  const response = await fatsecretGet("food/v1", { food_id: rawFoodId }, "FatSecret food.get");
  const food = response?.food;
  if (!food) throw new AppError("FatSecret food details were not found.", httpStatus.NOT_FOUND);

  const payload = {
    foodId: num(food.food_id),
    foodName: str(food.food_name),
    foodType: str(food.food_type),
    subCategories: arr(food.food_sub_categories?.food_sub_category).map(str).filter(Boolean),
    servings: arr(food.servings?.serving).map(parseServing),
  };
  return writeCache(detailCache, key, payload, detailCacheTtlMs);
};

const mapFoodSummary = ({ detail = null, rawFood = null, queryContext, groupKey }) => {
  const baseName = detail?.foodName || rawFood?.foodName || "";
  const servings = detail?.servings || [];
  const defaultServing = servings.find((serving) => serving.isDefault) || servings[0] || null;
  const exact100 = servings.find((serving) => serving.gramWeight && Math.abs(serving.gramWeight - 100) < 0.01) || null;
  const per100 = exact100 ? per100FromServing(exact100) : per100FromServing(defaultServing);
  const snippet = rawFood ? parseSearchSnippet(rawFood.foodDescription) : null;
  const fallbackPer100 =
    !per100 && snippet
      ? {
          nutrients:
            snippet.gramWeight && snippet.gramWeight > 0
              ? {
                  caloriesKcal: round(((snippet.nutrients.caloriesKcal || 0) * 100) / snippet.gramWeight, 1),
                  proteinG: round(((snippet.nutrients.proteinG || 0) * 100) / snippet.gramWeight, 1),
                  carbsG: round(((snippet.nutrients.carbsG || 0) * 100) / snippet.gramWeight, 1),
                  fatG: round(((snippet.nutrients.fatG || 0) * 100) / snippet.gramWeight, 1),
                  fiberG: round(((snippet.nutrients.fiberG || 0) * 100) / snippet.gramWeight, 1),
                  sugarG: round(((snippet.nutrients.sugarG || 0) * 100) / snippet.gramWeight, 1),
                }
              : completeNutrients(snippet.nutrients),
          exact: Boolean(snippet.gramWeight && Math.abs(snippet.gramWeight - 100) < 0.01),
          metricUnit: snippet.metricUnit || "g",
        }
      : null;
  const normalizedPer100 = completeNutrients(per100?.nutrients || fallbackPer100?.nutrients);

  const portionOptions = [];
  if (per100 || fallbackPer100) {
    upsertPortion(portionOptions, {
      label: (per100 || fallbackPer100).metricUnit === "ml" ? "100 ml serving" : "100 g serving",
      gramWeight: 100,
      estimated: !(per100?.exact || fallbackPer100?.exact),
    });
  }

  for (const serving of servings) {
    if (!serving.gramWeight || serving.gramWeight <= 0) continue;
    upsertPortion(portionOptions, {
      id: serving.servingId,
      label: cleanServingLabel(serving),
      amount: serving.numberOfUnits,
      gramWeight: serving.gramWeight,
      estimated: false,
    });
    if (portionOptions.length >= 8) break;
  }

  if (portionOptions.length === 0 && snippet?.gramWeight) {
    upsertPortion(portionOptions, {
      label: snippet.basis || "Serving",
      gramWeight: snippet.gramWeight,
      estimated: true,
    });
  }
  upsertPortion(portionOptions, { label: "Gram", gramWeight: 1, estimated: false });

  const defaultPortionOption =
    portionOptions.find((portion) => portion.label.toLowerCase().startsWith("100 ")) ||
    portionOptions[0];
  const factor = (num(defaultPortionOption?.gramWeight) || 0) / 100;
  const publicFood = {
    fdcId: encodeFoodId(detail?.foodId || rawFood?.foodId),
    description: canonicalName(baseName, queryContext),
    dataType: detail?.foodType || rawFood?.foodType || "Generic",
    brandName: "",
    brandOwner: "",
    foodCategory: str(detail?.subCategories?.[0]) || queryContext.baseLabel || canonicalName(baseName),
    servingSize: defaultPortionOption?.gramWeight || 100,
    servingSizeUnit: "g",
    nutrients: normalizedPer100,
    nutrientsPer100g: normalizedPer100,
    portionOptions,
    defaultPortionOption,
    display: {
      caloriesKcal: factor > 0 ? round(normalizedPer100.caloriesKcal * factor, 1) : null,
      proteinG: factor > 0 ? round(normalizedPer100.proteinG * factor, 1) : null,
      carbsG: factor > 0 ? round(normalizedPer100.carbsG * factor, 1) : null,
      fatG: factor > 0 ? round(normalizedPer100.fatG * factor, 1) : null,
    },
    _meta: {
      groupKey,
      basePhrase: inferBasePhrase(baseName, queryContext),
      variant: detectVariant(baseName),
      hasExact100g: Boolean(per100?.exact || fallbackPer100?.exact),
      nutritionCompleteness: nutrientCompleteness(normalizedPer100),
    },
  };

  saveSummary(publicFood);
  return publicFood;
};

const rankMappedFood = (food, queryContext) => {
  const description = norm(food.description);
  const exact = description === queryContext.normalizedQuery;
  const startsWith = description.startsWith(queryContext.normalizedQuery);
  let score = 0;
  if (exact) score += 1500;
  if (startsWith) score += 300;
  if (food._meta.basePhrase === queryContext.basePhrase) score += 240;
  score += food._meta.variant ? (queryContext.variant && food._meta.variant.key === queryContext.variant.key ? 130 : 90) : 180;
  score += food._meta.nutritionCompleteness * 20;
  if (food._meta.hasExact100g) score += 40;
  score -= Math.min(food.description.length, 120) / 8;
  return score;
};

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
};

const buildSearchDataset = async (query) => {
  const { maxFinalResults, detailConcurrency, searchCacheTtlMs } = getConfig();
  const queryContext = buildQueryContext(query);
  const cacheKey = `dataset:${queryContext.normalizedQuery}`;
  const cached = readCache(searchCache, cacheKey);
  if (cached) return cached;

  const source = await fetchSearchSource(query);
  const candidates = source.foods
    .filter(
      (food) =>
        food.foodType.toLowerCase() === "generic" &&
        !food.brandName &&
        !RESTAURANT_NOISE.test(norm([food.foodName, food.foodUrl, food.foodDescription].join(" "))) &&
        passesSimpleQueryFilter(food, queryContext)
    )
    .sort((left, right) => rawSearchScore(right, queryContext) - rawSearchScore(left, queryContext))
    .map((food) => ({
      ...food,
      groupKey: `${inferBasePhrase(food.foodName, queryContext)}|${detectVariant(food.foodName)?.key || "base"}`,
    }));

  const limited = [];
  const groupCounts = new Map();
  for (const food of candidates) {
    const count = groupCounts.get(food.groupKey) || 0;
    if (count >= 2) continue;
    groupCounts.set(food.groupKey, count + 1);
    limited.push(food);
    if (limited.length >= Math.min(maxFinalResults * 2, 40)) break;
  }

  const mapped = await mapWithConcurrency(limited, detailConcurrency, async (food) => {
    try {
      const detail = await fetchFoodDetail(encodeFoodId(food.foodId));
      return mapFoodSummary({ detail, rawFood: food, queryContext, groupKey: food.groupKey });
    } catch {
      return mapFoodSummary({ rawFood: food, queryContext, groupKey: food.groupKey });
    }
  });

  const byGroup = new Map();
  for (const food of mapped.filter(Boolean)) {
    food._meta.rankScore = rankMappedFood(food, queryContext);
    const current = byGroup.get(food._meta.groupKey);
    if (!current || food._meta.rankScore > current._meta.rankScore) byGroup.set(food._meta.groupKey, food);
  }

  const foods = Array.from(byGroup.values())
    .sort((left, right) => right._meta.rankScore - left._meta.rankScore)
    .slice(0, maxFinalResults)
    .map(stripMeta);

  return writeCache(searchCache, cacheKey, { foods }, searchCacheTtlMs);
};

const paginate = (foods, page, pageSize) => {
  const safePage = Math.max(Math.floor(page), 1);
  const safePageSize = Math.min(Math.max(Math.floor(pageSize), 1), 50);
  const start = (safePage - 1) * safePageSize;
  return {
    totalHits: foods.length,
    currentPage: safePage,
    totalPages: Math.max(Math.ceil(foods.length / safePageSize), 1),
    foods: foods.slice(start, start + safePageSize),
  };
};

const fetchAutocompleteSuggestions = async (query, limit) => {
  const response = await fatsecretGet(
    "food/autocomplete/v2",
    { expression: query, max_results: Math.min(Math.max(Math.floor(limit), 1), 10) },
    "FatSecret foods.autocomplete"
  );
  return arr(response?.suggestions?.suggestion).map(str).filter(Boolean);
};

export const fatsecretService = {
  async searchFoods({ query, page = 1, pageSize = 20 }) {
    const dataset = await buildSearchDataset(query);
    return paginate(dataset.foods, page, pageSize);
  },

  async getFoodSuggestions({ query, limit = 10 }) {
    try {
      const suggestions = await fetchAutocompleteSuggestions(query, limit);
      if (suggestions.length > 0) {
        return [...new Set(suggestions)]
          .filter((label) => !RESTAURANT_NOISE.test(norm(label)))
          .slice(0, Math.min(Math.max(Math.floor(limit), 1), 20))
          .map((label) => ({ label, value: norm(label), fdcId: null }));
      }
    } catch {
      // Fall back to normalized search-based suggestions when autocomplete is not enabled for the account.
    }

    const dataset = await buildSearchDataset(query);
    return dataset.foods.slice(0, Math.min(Math.max(Math.floor(limit), 1), 20)).map((food) => ({
      label: food.description,
      value: norm(food.description),
      fdcId: food.fdcId,
    }));
  },

  async getFoodByFdcId(publicFoodId) {
    const cached = readCache(summaryCache, String(publicFoodId));
    if (cached) return cached;
    const detail = await fetchFoodDetail(publicFoodId);
    const queryContext = buildQueryContext(detail.foodName);
    return stripMeta(
      mapFoodSummary({
        detail,
        queryContext,
        groupKey: `${inferBasePhrase(detail.foodName, queryContext)}|${detectVariant(detail.foodName)?.key || "base"}`,
      })
    );
  },
};
