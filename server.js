const mongoose = require("mongoose");
const dotenv = require("dotenv");
dotenv.config({ path: "./config.env" });

process.on("uncaughtException", (err) => {
  console.log(err);
  console.log("UNCAUGHT Exception! Shutting down ...");
  process.exit(1); // Exit Code 1 indicates that a container shut down, either because of an application failure.
});

const app = require("./app");

const http = require("http");
const server = http.createServer(app);

const { Server } = require("socket.io");
const { promisify } = require("util");
const User = require("./models/user");
const FriendRequest = require("./models/friendRequest");

// Add this
// Create an io server and allow for CORS from http://localhost:3000 with GET and POST methods
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

const DB = process.env.DATABASE.replace(
  "<PASSWORD>",
  process.env.DATABASE_PASSWORD
);

mongoose
  .connect(DB, {
    // useNewUrlParser: true, // The underlying MongoDB driver has deprecated their current connection string parser. Because this is a major change, they added the useNewUrlParser flag to allow users to fall back to the old parser if they find a bug in the new parser.
    // useCreateIndex: true, // Again previously MongoDB used an ensureIndex function call to ensure that Indexes exist and, if they didn't, to create one. This too was deprecated in favour of createIndex . the useCreateIndex option ensures that you are using the new function calls.
    // useFindAndModify: false, // findAndModify is deprecated. Use findOneAndUpdate, findOneAndReplace or findOneAndDelete instead.
    // useUnifiedTopology: true, // Set to true to opt in to using the MongoDB driver's new connection management engine. You should set this option to true , except for the unlikely case that it prevents you from maintaining a stable connection.
  })
  .then((con) => {
    console.log("DB Connection successful");
  })
  .catch((error) => {
    console.log("Failed to connect with mongodb");
    console.log(error);
  });

const port = process.env.PORT || 8000;

server.listen(port, () => {
  console.log(`App running on port ${port} ...`);
});

// Add this
// Listen for when the client connects via socket.io-client
io.on("connection", async (socket) => {
  console.log(JSON.stringify(socket.handshake.query));
  const userId = socket.handshake.query["userId"];

  console.log(`User connected via socket id ${socket.id}`);

  if (userId * 1 !== 0 && Boolean(userId)) {
    await User.findByIdAndUpdate(userId, { socketId: socket.id });
  }

  // We can write our socket event listeners in here...
  socket.on("friend_request", async (data) => {
    console.log(data.to);

    const to = await User.findById(data.to).select("socketId");

    const from = await User.findById(data.from).select("socketId");

    // create a friend request
    await FriendRequest.create({
      sender: data.from,
      recipient: data.to,
    });
    // emit event request received to recipient
    io.to(to.socketId).emit("new_friend_request", {
      message: "New friend request received",
    });

    io.to(from.socketId).emit("new_friend_request", {
      message: "Request sent successfully",
    });
  });

  socket.on("accept_request", async (data) => {
    // accept friend request => add ref of each other in friend array
    console.log(data);

    const requestDoc = await FriendRequest.findById(data.requestId);

    console.log(requestDoc);

    const sender = await User.findById(requestDoc.sender);
    const receiver = await User.findById(requestDoc.recipient);

    sender.friends.push(requestDoc.recipient);
    receiver.friends.push(requestDoc.sender);

    await receiver.save({ new: true, validateModifiedOnly: true });
    await sender.save({ new: true, validateModifiedOnly: true });

    await FriendRequest.findByIdAndDelete(data.requestId);

    // delete this request doc
    // emit event to both of them
    // emit event request accepted to both

    io.to(sender.socketId).emit("request_accepted", {
      message: "Friend request accepted",
    });

    io.to(receiver.socketId).emit("request_accepted", {
      message: "Friend request accepted",
    });
  });

  socket.on("end", function () {
    console.log("Closing connection");
    socket.disconnect(0);
  });
});

process.on("unhandledRejection", (err) => {
  console.log(err);
  console.log("UNHANDLED REJECTION! Shutting down ...");
  server.close(() => {
    process.exit(1); //  Exit Code 1 indicates that a container shut down, either because of an application failure.
  });
});
