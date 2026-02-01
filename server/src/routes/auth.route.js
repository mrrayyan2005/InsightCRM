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
    
    // Use authenticate as middleware
    await authenticate(req, res, () => {});
    
    // If we get here, user is authenticated
    res.json({ user: req.user });
  } catch (error) {
    // Return 401 with user: null instead of throwing error
    res.status(401).json({ 
      statusCode: 401,
      message: "Unauthorized",
      user: null 
    });
  }
});

export default router;
