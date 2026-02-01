import mongoose from "mongoose";
import { DB_NAME } from "../constants.js";

const connectDB = async () => {
  try {
    // Check if MONGODB_URI is set
    if (!process.env.MONGODB_URI) {
      console.error("ERROR: MONGODB_URI environment variable is not set!");
      console.error("Please set MONGODB_URI in your environment variables");
      return false;
    }

    console.log("Attempting to connect to MongoDB...");
    console.log("Database name:", DB_NAME);
    console.log("MONGODB_URI configured:", !!process.env.MONGODB_URI);

    const connectionInstance = await mongoose.connect(
      `${process.env.MONGODB_URI}/${DB_NAME}`,
      {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        connectTimeoutMS: 10000,
      }
    );
    
    console.log("✅ MongoDB connected successfully!");
    console.log("Host:", connectionInstance.connection.host);
    return true;
   
  } catch (error) {
    console.error("❌ MongoDB connection error:");
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    
    if (error.name === 'MongooseServerSelectionError') {
      console.error("\nPossible causes:");
      console.error("1. MONGODB_URI is incorrect or malformed");
      console.error("2. MongoDB Atlas IP whitelist doesn't allow Render's IP addresses");
      console.error("3. Database username/password is incorrect");
      console.error("4. Network connectivity issues");
    }
    
    console.log("\n⚠️ Server will continue without database connection");
    return false;
  }
};

export default connectDB;
