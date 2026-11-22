
require("dotenv").config({
  path: require("path").join(__dirname, "..", "..", ".env")
});

const mongoose = require("mongoose");
const { connectMongo } = require("../config/mongo");

const ORDER_ID = "6b02985bd6e649864a294588";

async function findOrder() {
  try {
    await connectMongo();

    console.log("Connected database:", mongoose.connection.name);

    const collections = await mongoose.connection.db
      .listCollections()
      .toArray();

    const id = new mongoose.Types.ObjectId(ORDER_ID);
    let found = false;

    for (const collection of collections) {
      const result = await mongoose.connection.db
        .collection(collection.name)
        .findOne({ _id: id });

      if (result) {
        found = true;

        console.log("\nORDER FOUND!");
        console.log("Collection:", collection.name);
        console.log("Document ID:", result._id);
        console.log("Available fields:", Object.keys(result));
      }
    }

    if (!found) {
      console.log("\nORDER NOT FOUND IN ANY COLLECTION.");
      console.log("Check the database, order ID, and order creation process.");
    }
  } catch (error) {
    console.error("Diagnostic error:", error);
  } finally {
    await mongoose.connection.close();
  }
}

findOrder();