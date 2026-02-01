import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import verifyGoogleToken from "../utils/googleOAuth.js";
import { generateTokens, verifyRefreshToken } from "../utils/jwt.js";
import { User } from "../models/user.model.js";

const googleLogin = asyncHandler(async (req, res) => {
  const { token } = req.body;

  if (!token) {
    throw new ApiError(400, "Google token is required");
  }

  console.log("Google login attempt - token received:", !!token);
  console.log("Google Client ID configured:", !!process.env.GOOGLE_CLIENT_ID);

  const googleUser = await verifyGoogleToken(token);
  
  if (!googleUser) {
    console.error("Google token verification failed");
    throw new ApiError(401, "Invalid Google token");
  }

  console.log("Google user verified:", googleUser.email);

  try {
    // Check if user exists
    let user = await User.findOne({ email: googleUser.email });

    if (!user) {
      console.log("Creating new user for:", googleUser.email);
      // Create new user with all required fields
      user = await User.create({
        googleId: googleUser.sub,
        email: googleUser.email,
        name: googleUser.name || googleUser.email.split('@')[0],
        avatar: googleUser.picture || "",
        isVerified: true,
      });
      console.log("New user created successfully");
    } else {
      console.log("Updating existing user:", googleUser.email);
      // Update existing user with latest Google data
      user.googleId = googleUser.sub;
      user.name = googleUser.name || user.name;
      user.avatar = googleUser.picture || user.avatar;
      user.isVerified = true;
      await user.save();
      console.log("User updated successfully");
    }

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(user);

    // Set cookies
    const isProduction = process.env.NODE_ENV === "production";
    const cookieOptions = {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "None" : "Lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    };

    res.cookie("accessToken", accessToken, cookieOptions);
    res.cookie("refreshToken", refreshToken, cookieOptions);

    // Return user data without sensitive fields
    const userData = {
      _id: user._id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      googleId: user.googleId,
      isVerified: user.isVerified,
    };

    console.log("Login successful for:", userData.email);
    return res
      .status(200)
      .json(new ApiResponse(200, { user: userData }, "Login successful"));
  } catch (dbError) {
    console.error("Database error during login:", dbError);
    throw new ApiError(500, "Database error: " + dbError.message);
  }
});

const logout = asyncHandler(async (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";
  
  res.clearCookie("accessToken", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "None" : "Lax",
    path: "/"
  });
  
  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "None" : "Lax",
    path: "/"
  });

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Logged out successfully"));
});

const refreshAccessToken = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    // Return 401 without throwing error to avoid global error logging
    return res
      .status(401)
      .json(new ApiResponse(401, null, "No refresh token provided"));
  }

  try {
    const decoded = verifyRefreshToken(refreshToken);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res
        .status(401)
        .json(new ApiResponse(401, null, "Invalid refresh token - user not found"));
    }

    const { accessToken } = generateTokens(user);

    res.cookie("accessToken", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
      maxAge: 15 * 60 * 1000, // 15 minutes
    });

    return res
      .status(200)
      .json(new ApiResponse(200, { accessToken }, "Access token refreshed"));
  } catch (error) {
    console.error("Refresh token error:", error.message);
    return res
      .status(401)
      .json(new ApiResponse(401, null, "Invalid or expired refresh token"));
  }
});

export { googleLogin, logout, refreshAccessToken };
