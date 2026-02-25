/**
 * Wrap async route handlers so errors go to global error handler automatically.
 * Usage: router.get("/", catchAsync(async (req,res)=>{...}))
 */
export const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
