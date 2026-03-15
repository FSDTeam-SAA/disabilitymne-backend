# Express + MongoDB + Cloudinary Scaffold

Includes:
- Express.js app bootstrap
- MongoDB via Mongoose
- Cloudinary file uploads using `multer` + `multer-storage-cloudinary`
- JWT auth (register/login/protected routes)
- Refresh-token auth rotation (`accessToken` + `refreshToken`)
- OTP-based password reset flow with branded email delivery
- User onboarding + plan selection APIs
- Stripe Checkout payment flow with API-based confirmation (webhook optional) + receipt emails
- Programs/Exercises APIs with global and premium-assigned visibility
- Recipes APIs with global and premium-assigned visibility
- `catchAsync` helper for async controllers
- Global error handler + `AppError`
- Security + common middlewares: Helmet, CORS, Mongo sanitize, HPP
- Example Upload APIs (`POST /api/v1/uploads/image`, `POST /api/v1/uploads/video`)

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Configure SMTP values in `.env` if you want password-reset OTP emails and payment receipts to be sent:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_smtp_username
SMTP_PASS=your_smtp_password
EMAIL_FROM_NAME=DisabilityMNE
EMAIL_FROM_ADDRESS=no-reply@example.com
APP_BASE_URL=http://localhost:3000
```

If SMTP settings are missing, the backend will continue working and log that email delivery was skipped.

Configure Stripe values in `.env` for paid plans:

```env
STRIPE_SECRET_KEY=sk_test_replace_me
# Optional: only needed if you also enable Stripe webhooks
# STRIPE_WEBHOOK_SECRET=whsec_replace_me
FRONTEND_URL=http://localhost:3000
PAYMENT_SUCCESS_URL=http://localhost:3000/payment/success
PAYMENT_CANCEL_URL=http://localhost:3000/payment/cancel
```

## Upload Example

`POST /api/v1/uploads/image` or `POST /api/v1/uploads/video` with form-data:
- key: `file` (type: File)
- optional: `folder` (string)

Response returns Cloudinary `secure_url` etc.

## Multipart Image Fields

These endpoints now expect `multipart/form-data` when you want to upload images directly instead of passing image URLs:

- `PATCH /api/v1/users/me` (single endpoint for profile + onboarding fields)
  - image field: `profileImage`
- `PATCH /api/v1/users/me/profile-image`
  - image field: `profileImage` (also accepts `avatar` or `image`)
- `PATCH /api/v1/admin/settings/profile`
  - image field: `profileImage`
- `POST|PATCH /api/v1/programs/admin`
  - image fields: `programImages`, `programThumbnails`
- `POST|PATCH /api/v1/recipes/admin`
  - image field: `recipeImages`
- `POST|PATCH /api/v1/exercises/admin`
  - media fields: `exerciseImages`, `targetMuscleImages`, `demoVideo`/`demoVideos`
  - training defaults: either `defaultSets` (array of `{ setNumber, reps, durationSeconds/countdown, weightKg }`)
    or simple fields `sets`, `reps`, `countdown` (weight defaults to `1kg`)

Notes:
- Include optional `folder` in form-data if you want a custom Cloudinary folder.
- Non-file values can stay as regular text fields in the same multipart request.
- Exercise demo videos can now be uploaded directly in the same multipart request and are stored in Cloudinary before saving to `demoVideos`.

## Auth APIs

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh-token`
- `POST /api/v1/auth/logout` (protected)
- `POST /api/v1/auth/forgot-password/send-otp`
- `POST /api/v1/auth/forgot-password/verify-otp`
- `POST /api/v1/auth/forgot-password/reset`

Use `Authorization: Bearer <token>` for protected endpoints.

## User APIs (Protected)

- `GET /api/v1/users/me`
- `PATCH /api/v1/users/me/profile-image` (update profile image only; accepts multipart file `profileImage|avatar|image`)
- `PATCH /api/v1/users/me` (updates both profile and onboarding fields)
- `PATCH /api/v1/users/me/onboarding` (backward-compatible alias of `/me`)
- `POST /api/v1/users/me/select-plan`
- `GET /api/v1/users/me/home` (home dashboard cards: welcome, stats, my programs, my recipes)
- `GET /api/v1/users/me/profile` (profile payload)
- `GET /api/v1/users/me/progress` (progress cards, weekly charts, body metrics)
- `GET /api/v1/users/me/daily-tracker`
- `PATCH /api/v1/users/me/daily-tracker` (toggle/update habit cells)
- `POST /api/v1/users/me/daily-tracker/notes`
- `POST /api/v1/users/me/workouts/logs` (log completed exercise/workout sets)
- `GET /api/v1/users/me/workouts/logs`
- `GET /api/v1/users/me/exercises/:exerciseId/settings` (effective exercise sets config for current user)
- `PUT /api/v1/users/me/exercises/:exerciseId/settings` (save user-specific exercise sets/reps/countdown/weight)
- `DELETE /api/v1/users/me/exercises/:exerciseId/settings` (reset to admin defaults)
- `POST /api/v1/users/me/workouts/experiences` (workout completion feedback: `experienceLevel` + optional `notes`)
- `GET /api/v1/users/me/workouts/experiences`
- `GET /api/v1/users/me/notifications`
- `PATCH /api/v1/users/me/notifications/:notificationId/read`
- `PATCH /api/v1/users/me/notifications/read-all`
- `GET /api/v1/users/me/language`
- `PATCH /api/v1/users/me/language`
- `POST /api/v1/users/me/support/tickets` (help & support submit)
- `GET /api/v1/users/me/support/tickets`
- `POST /api/v1/users/me/change-password`

## Payment APIs

- `GET /api/v1/payments/plans` (public)
- `POST /api/v1/payments/checkout` (protected)
- `POST /api/v1/payments/checkout/confirm` (protected, webhook-free confirmation using `sessionId`)
- `GET /api/v1/payments/checkout/confirm/:sessionId` (protected, webhook-free confirmation/polling)
- `POST /api/v1/payments/webhook` (public, optional Stripe webhook endpoint)
- `GET /api/v1/payments/me` (protected)

Flutter WebView flow (no webhook required):
1. Call `POST /api/v1/payments/checkout` and open `data.checkoutUrl` in WebView.
2. On redirect to your `successUrl`, read `session_id` from the URL query.
3. Call `POST /api/v1/payments/checkout/confirm` with `{ "sessionId": "cs_..." }`.
4. Use returned `data.payment.status` and `data.user.subscriptionStatus` to unlock premium.

## Program APIs (Exercises)

### User-facing (Protected)

- `GET /api/v1/programs/explore` -> shared programs (`normal_user`) available to all users
- `GET /api/v1/programs/my` -> private programs assigned to logged-in user (requires active premium)
- `GET /api/v1/programs/all` -> shared + assigned private programs (private included only if active premium)
- `GET /api/v1/programs/:programId` -> program details with access control

### Admin (Protected + role `admin`)

- `GET /api/v1/programs/admin`
- `POST /api/v1/programs/admin`
- `GET /api/v1/programs/admin/:programId`
- `PATCH /api/v1/programs/admin/:programId`
- `DELETE /api/v1/programs/admin/:programId` (soft archive)
- `GET /api/v1/programs/admin/premium-users` (for "select premium user" dropdown)

`POST /api/v1/programs/admin` accepts:
- `userType`: `normal_user` or `premium_user`
- `assignedUser`/`assignedUserId`/`targetUserId` required when `userType=premium_user`
- `programName`, `programDuration` + `durationMinutes`, `programLevel`, `programDescription`, `mobilityType`
- `programImages`, `programThumbnails` (URL/object payloads)
- `exercises` array with per-exercise metadata:
  - `name`, `description`, `keyBenefits[]`
  - `demoVideos[]` (multiple exercise demo videos)
  - `exerciseImages[]` (multiple exercise images)
  - `targetMuscleImages[]` (front/back or multiple target muscle references)
  - `defaultSets[]`, `durationSeconds`, `calories`

## Recipe APIs

### User-facing (Protected)

- `GET /api/v1/recipes/explore` -> shared recipes (`normal_user`) for all users (free trial/monthly/six-month/premium)
- `GET /api/v1/recipes/my` -> private recipes assigned to logged-in user (requires active premium)
- `GET /api/v1/recipes/all` -> shared + assigned private recipes (private included only if active premium)
- `GET /api/v1/recipes/:recipeId` -> recipe details with access control

### Admin (Protected + role `admin`)

- `GET /api/v1/recipes/admin`
- `POST /api/v1/recipes/admin`
- `GET /api/v1/recipes/admin/:recipeId`
- `PATCH /api/v1/recipes/admin/:recipeId`
- `DELETE /api/v1/recipes/admin/:recipeId` (soft archive)
- `GET /api/v1/recipes/admin/premium-users` (for "select premium user" dropdown)

`POST /api/v1/recipes/admin` accepts:
- `userType`: `normal_user` or `premium_user`
- `assignedUser`/`assignedUserId`/`targetUserId` required when `userType=premium_user`
- `recipeName`, `recipeDuration` + `durationMinutes`, `recipeType`, `howToPrepare`
- `caloriesKcal`, `proteinG`, `carbsG`, `fatG`
- `recipeImages` (URL/object payloads)
- `ingredients` array

## Admin Dashboard APIs (role: `admin`)

- `GET /api/v1/admin/dashboard/overview` (totals, revenue series, subscription survey, recent users)
- `GET /api/v1/admin/users` (pagination/filter/search/sort for user management table)
- `PATCH /api/v1/admin/users/:userId/status` (`active|deactivated|suspended`)
- `DELETE /api/v1/admin/users/:userId` (soft deactivate)
- `GET /api/v1/admin/support/tickets`
- `GET /api/v1/admin/support/tickets/:ticketId`
- `PATCH /api/v1/admin/support/tickets/:ticketId`
- `GET /api/v1/admin/workout-experiences`
- `GET /api/v1/admin/workout-experiences/:experienceId`
- `GET /api/v1/admin/settings/profile`
- `PATCH /api/v1/admin/settings/profile`
- `PATCH /api/v1/admin/settings/password`
- `GET /api/v1/admin/subscriptions/plans`
- `POST /api/v1/admin/subscriptions/plans`
- `PATCH /api/v1/admin/subscriptions/plans/:planKey`
- `DELETE /api/v1/admin/subscriptions/plans/:planKey`

## Project Structure

```
src/
  app.js
  server.js
  config/
  controllers/
  middlewares/
  models/
  routes/
  utils/
```
# disabilitymne-backend


