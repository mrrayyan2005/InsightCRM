import { User } from "../models/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { verifyAccessToken } from "../utils/jwt.js";

export const authenticate = asyncHandler(async (req, res, next) => {
  try {
    // 1. Get token from cookies or Authorization header
    const token =
      req.cookies?.accessToken ||
      req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      // Return 401 response instead of throwing error
      return res.status(401).json({
        success: false,
        statusCode: 401,
        message: "Unauthorized request - No token provided",
        data: null
      });
    }

    // 2. Verify token
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        statusCode: 401,
        message: "Invalid access token",
        data: null
      });
    }

    // 3. Get user from DB and attach to request
    const user = await User.findById(decoded.id).select(
      "-password -refreshToken"
    );
    if (!user) {
      return res.status(401).json({
        success: false,
        statusCode: 401,
        message: "User not found",
        data: null
      });
    }

    // 4. Attach user to request object
    req.user = user;
    next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    return res.status(401).json({
      success: false,
      statusCode: 401,
      message: error?.message || "Invalid access token",
      data: null
    });
  }
});

const isProduction = process.env.NODE_ENV === "production";
export const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "None" : "Lax",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
