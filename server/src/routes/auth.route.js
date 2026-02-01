import { Router } from "express";
import {
  googleLogin,
  logout,
  refreshAccessToken,
} from "../controllers/auth.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = Router();

router.route("/google-login").post(googleLogin);
router.route("/logout").post(logout);
router.route("/refresh-token").post(refreshAccessToken);

// Verify endpoint - handles missing tokens gracefully
router.route("/verify").get(async (req, res) => {
  try {
    // Import authenticate middleware inline to handle errors
    const { authenticate } = await import("../middleware/auth.middleware.js");
    const { ApiResponse } = await import("../utils/ApiResponse.js");
    
    // Use authenticate as middleware
    await authenticate(req, res, () => {});
    
    // If we get here, user is authenticated - return consistent format
    return res.status(200).json(new ApiResponse(200, { user: req.user }, "User verified"));
  } catch (error) {
    // Return 401 with user: null instead of throwing error
    return res.status(401).json(new ApiResponse(401, { user: null }, "Unauthorized"));
  }
});

export default router;
