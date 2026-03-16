# Nutrition Screens -> Backend Contract (Figma Handoff)

Updated: 2026-03-16

This maps your screenshot screens to the backend fields so frontend can bind directly.

## 1) Calculator Home Screen

Endpoint:
- `GET /api/v1/nutrition/diary?date=YYYY-MM-DD`

Optional query params for target/goal calculation:
- `goal` (`fat_loss | maintenance | muscle_gain`)
- `weightKg`
- `proteinPerKg`
- `carbsPerKg`
- `fatPerKg`
- `caloriesPerKg`
- `useGoalWeight` (`true | false`)

Use these fields:
- `data.energy.eatenKcal` -> **Eaten**
- `data.energy.burnedKcal` -> **Burned**
- `data.energy.goalKcal` -> **Goal**
- `data.energy.remainingKcal` -> **Remaining**
- `data.macroProgress.carbs/protein/fat` -> consumed/target/remaining/progress
- `data.meals[]` -> breakfast/lunch/dinner/snack cards
- `data.meals[].recommendation.recommendedCalories.minKcal/maxKcal` -> recommended kcal range per meal

## 2) Breakfast -> History Tab

Endpoint:
- `GET /api/v1/nutrition/history?mealType=breakfast&limit=20&page=1`

Optional:
- `query` (search text)

Use:
- `data.entries[]` for recent tracked items list
- `DELETE /api/v1/nutrition/diary/entries/:entryId` for remove (`X`) action

## 3) Breakfast -> Favorite Tab

Endpoint:
- `GET /api/v1/nutrition/favorites?limit=20`
- `GET /api/v1/nutrition/favorites/sections?limit=20`

Use:
- `data[]` favorite foods
- Item has `isFavorite`, calories/macros, grams, serving label
- For 3-section UI, use `/favorites/sections`:
  - `data.foods[]`
  - `data.meals[]` (currently empty placeholder)
  - `data.recipes[]` (currently empty placeholder)

## 4) Breakfast -> Tracked Tab

Endpoint:
- `GET /api/v1/nutrition/diary?date=YYYY-MM-DD`

Use:
- `data.meals[].entries[]` filtered by `mealType`

## 5) Search Screen

Endpoints:
- `GET /api/v1/nutrition/foods/suggestions?q=apple&limit=10`
- `GET /api/v1/nutrition/foods/search?query=apple&page=1&pageSize=20`

Use:
- Search result item includes `description`, `fdcId`, nutrients summary

## 6) Food Detail (Track / Update Screen)

Endpoints:
- `GET /api/v1/nutrition/foods/:fdcId`
- `POST /api/v1/nutrition/diary/entries`
- `PATCH /api/v1/nutrition/diary/entries/:entryId`
- `GET /api/v1/nutrition/diary/entries/:entryId`

Use:
- `data.portionOptions[]` -> dropdown options (slice/whole/gram etc if USDA provides)
- `data.nutrientsPer100g` -> live quantity/grams recalculation on UI

## 7) "How much" Dropdown

From:
- `GET /api/v1/nutrition/foods/:fdcId`

Use:
- `portionOptions[].label`
- `portionOptions[].gramWeight`

Always available fallback:
- `Gram` option (`gramWeight = 1`)

## 8) Meal Summary Card (Bottom Card in Screenshot)

From:
- `GET /api/v1/nutrition/diary?date=...` (same response)

Use:
- `data.meals[].totals.caloriesKcal` -> meal eaten kcal
- `data.meals[].recommendation.recommendedCalories.minKcal/maxKcal` -> meal recommendation range
- `data.macroPercentages` and `data.macroProgress` -> donut + legend

## 9) Example Response Snippets

### `GET /nutrition/diary`

```json
{
  "success": true,
  "data": {
    "date": "2026-03-16T00:00:00.000Z",
    "totals": {
      "caloriesKcal": 72,
      "proteinG": 1.1,
      "carbsG": 17.0,
      "fatG": 0.2,
      "fiberG": 2.4,
      "sugarG": 10.4,
      "totalGrams": 125
    },
    "macroPercentages": {
      "proteinPercent": 2.3,
      "carbsPercent": 92.6,
      "fatPercent": 5.1
    },
    "macroProgress": {
      "carbs": { "consumedG": 17, "targetG": 328, "remainingG": 311, "progressPercent": 5.2 },
      "protein": { "consumedG": 1.1, "targetG": 131, "remainingG": 129.9, "progressPercent": 0.8 },
      "fat": { "consumedG": 0.2, "targetG": 87, "remainingG": 86.8, "progressPercent": 0.2 }
    },
    "targets": {
      "weightKg": 73,
      "goal": "maintenance",
      "macros": { "proteinG": 131, "carbsG": 328, "fatG": 87 },
      "calories": { "recommendedCalories": 1792, "minCalories": 1560, "maxCalories": 2340 }
    },
    "energy": {
      "eatenKcal": 72,
      "burnedKcal": 0,
      "netKcal": 72,
      "goalKcal": 1792,
      "remainingKcal": 1720,
      "status": "under"
    },
    "meals": [
      {
        "mealType": "breakfast",
        "recommendation": {
          "recommendedCalories": { "minKcal": 409, "maxKcal": 723 }
        }
      }
    ]
  }
}
```

### `GET /nutrition/foods/:fdcId`

```json
{
  "success": true,
  "data": {
    "fdcId": 12345,
    "description": "Apple, raw",
    "nutrients": { "caloriesKcal": 52, "proteinG": 0.3, "carbsG": 13.8, "fatG": 0.2 },
    "nutrientsPer100g": { "caloriesKcal": 52, "proteinG": 0.3, "carbsG": 13.8, "fatG": 0.2 },
    "portionOptions": [
      { "label": "Slice", "gramWeight": 12.5 },
      { "label": "Half", "gramWeight": 62.5 },
      { "label": "Whole", "gramWeight": 125 },
      { "label": "Gram", "gramWeight": 1 }
    ]
  }
}
```
