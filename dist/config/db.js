import mongoose from "mongoose";
export async function connectDb(uri) {
    if (!uri) {
        throw new Error("MONGODB_URI is not set. Add your Atlas connection string to server/.env");
    }
    mongoose.set("strictQuery", true);
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    return mongoose.connection;
}
export async function disconnectDb() {
    await mongoose.disconnect();
}
