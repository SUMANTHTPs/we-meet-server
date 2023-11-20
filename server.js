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
const OneToOneMessage = require("./models/oneToOneMessage");
const AudioCall = require("./models/audioCall");
const VideoCall = require("./models/videoCall");

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

  if (Boolean(userId) && userId) {
    await User.findByIdAndUpdate(userId, {
      socketId: socket.id,
      status: "Online",
    });
  }

  // We can write our socket event listeners in here...
  socket.on("friend_request", async (data) => {
    const to = await User.findById(data.to).select("socketId");

    const from = await User.findById(data.from).select("socketId");

    // create a friend request
    await FriendRequest.create({
      sender: data.from,
      recipient: data.to,
    });
    // emit event request received to recipient
    io.to(to?.socketId).emit("new_friend_request", {
      message: "New friend request received",
    });

    io.to(from?.socketId).emit("request_sent", {
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

    io.to(sender?.socketId).emit("request_accepted", {
      message: "Friend request accepted",
    });

    io.to(receiver?.socketId).emit("request_accepted", {
      message: "Friend request accepted",
    });
  });

  socket.on("get_direct_conversations", async ({ userId }, callback) => {
    const existingConversations = await OneToOneMessage.find({
      participants: { $all: [userId] },
    }).populate("participants", "firstName lastName _id email status");

    // db.books.find({ authors: { $elemMatch: { name: "John Smith" } } })

    console.log(existingConversations);

    callback(existingConversations);
  });

  socket.on("start_conversation", async (data) => {
    // data: {to: from:}
    const { to, from } = data;

    // check if there is any existing conversation
    const existingConversations = await OneToOneMessage.find({
      participants: { $size: 2, $all: [to, from] },
    }).populate("participants", "firstName lastName _id email status");

    console.log(existingConversations[0], "Existing Conversation");

    // if no => create a new OneToOneMessage doc & emit event "start_chat" & send conversation details as payload
    if (existingConversations.length === 0) {
      let newChat = await OneToOneMessage.create({
        participants: [to, from],
      });

      newChat = await OneToOneMessage.findById(newChat).populate(
        "participants",
        "firstName lastName _id email status"
      );

      console.log(newChat);
      // TODO
      socket.emit("start_chat", newChat);
    }
    // if yes => just emit event "start_chat" & send conversation details as payload
    else {
      // TODO
      socket.emit("start_chat", existingConversations[0]);
    }
  });

  socket.on("get_messages", async (data, callback) => {
    try {
      const conversation = await OneToOneMessage.findById(data.conversationId);

      if (!conversation) {
        // Handle the case where the conversation document is not found
        console.error(`Conversation not found for ID ${data.conversationId}`);
        return;
      }

      const { messages } = conversation;
      // Now you can use the 'messages' variable as needed
      callback(messages);
    } catch (error) {
      console.error("Error fetching messages:", error);
      // Handle other errors as needed
    }
  });

  // Handle incoming text/link message
  socket.on("text_message", async (data) => {
    console.log("Received message:", data);

    // data: {to, from, text}
    const { message, conversationId, from, to, type } = data;

    const toUser = await User.findById(to);
    const fromUser = await User.findById(from);

    // message => {to, from, type, created_at, text, file}

    const newMessage = {
      to: to,
      from: from,
      type: type,
      created_at: Date.now(),
      text: message,
    };

    // create a new conversation if its dosent exists yet or add a new message to existing conversation
    // fetch OneToOneMessage Doc & push a new message to existing conversation
    const chat = await OneToOneMessage.findById(conversationId);
    chat.messages.push(newMessage);

    // save to db
    await chat.save({ new: true, validateModifiedOnly: true });

    // emit incoming_message -> to user
    io.to(toUser?.socketId).emit("new_message", {
      conversationId,
      message: newMessage,
    });

    // emit outgoing_message -> from user
    io.to(fromUser?.socketId).emit("new_message", {
      conversationId,
      message: newMessage,
    });
  });

  // handle Media/Document Message
  socket.on("file_message", (data) => {
    console.log("Received message:", data);

    // data: {to, from, text, file}

    // Get the file extension
    const fileExtension = path.extname(data.file.name);

    // Generate a unique filename
    const filename = `${Date.now()}_${Math.floor(
      Math.random() * 10000
    )}${fileExtension}`;

    // upload file to AWS s3

    // create a new conversation if its doesn't exists yet or add a new message to existing conversation

    // save to db

    // emit incoming_message -> to user

    // emit outgoing_message -> from user
  });

  // -------------- HANDLE AUDIO CALL SOCKET EVENTS ----------------- //
  // handle start_audio_call event
  socket.on("start_audio_call", async (data) => {
    const { from, to, roomID } = data;

    const toUser = await User.findById(to);
    const fromUser = await User.findById(from);

    // create a new audio call record === log
    await AudioCall.create({
      participants: [from, to],
      from,
      to,
      status: "Ongoing",
    });

    // send notification to receiver of call
    io.to(toUser?.socketId).emit("audio_call_notification", {
      from: fromUser,
      roomID,
      streamID: from,
      userID: to,
      userName: to,
    });
  });

  // handle audio_call_not_picked
  socket.on("audio_call_not_picked", async (data) => {
    console.log(data);
    // find and update call record
    const { to, from } = data;

    const toUser = await User.findById(to);

    await AudioCall.findOneAndUpdate(
      {
        participants: { $size: 2, $all: [to, from] },
      },
      { verdict: "Missed", status: "Ended", endedAt: Date.now() }
    );
    // emit audio_call_missed to receiver of call
    io.to(toUser?.socketId).emit("audio_call_missed", {
      from,
      to,
    });
  });

  // handle audio_call_accepted
  socket.on("audio_call_accepted", async (data) => {
    // find and update call record
    const { to, from } = data;

    const fromUser = await User.findById(from);

    // find and update call record
    await AudioCall.findOneAndUpdate(
      {
        participants: { $size: 2, $all: [to, from] },
      },
      { verdict: "Accepted" }
    );
    // emit call_accepted to sender of call
    io.to(fromUser?.socketId).emit("audio_call_accepted", {
      from,
      to,
    });
  });

  // handle audio_call_denied
  socket.on("audio_call_denied", async (data) => {
    // find and update call record
    const { to, from } = data;

    await AudioCall.findOneAndUpdate(
      {
        participants: { $size: 2, $all: [to, from] },
      },
      { verdict: "Denied", status: "Ended", endedAt: Date.now() }
    );

    const fromUser = await User.findById(from);
    // emit call_denied to sender of call
    io.to(fromUser?.socketId).emit("audio_call_denied", {
      from,
      to,
    });
  });

  // handle user_is_busy_audio_call
  socket.on("user_is_busy_audio_call", async (data) => {
    const { to, from } = data;
    // find and update call record
    await AudioCall.findOneAndUpdate(
      {
        participants: { $size: 2, $all: [to, from] },
      },
      { verdict: "Busy", status: "Ended", endedAt: Date.now() }
    );

    const fromUser = await User.findById(from);
    // emit on_another_audio_call to sender of call
    io.to(fromUser?.socketId).emit("on_another_audio_call", {
      from,
      to,
    });
  });

  // --------------------- HANDLE VIDEO CALL SOCKET EVENTS ---------------------- //
  // handle start_video_call event
  socket.on("start_video_call", async (data) => {
    const { from, to, roomID } = data;

    const toUser = await User.findById(to);
    const fromUser = await User.findById(from);

    // create a new video call record === log
    await VideoCall.create({
      participants: [from, to],
      from,
      to,
      status: "Ongoing",
    });

    // send notification to receiver of call
    io.to(toUser?.socketId).emit("video_call_notification", {
      from: fromUser,
      roomID,
      streamID: from,
      userID: to,
      userName: to,
    });
  });

  // handle video_call_not_picked
  socket.on("video_call_not_picked", async (data) => {
    console.log(data);
    // find and update call record
    const { to, from } = data;

    const toUser = await User.findById(to);

    await VideoCall.findOneAndUpdate(
      {
        participants: { $size: 2, $all: [to, from] },
      },
      { verdict: "Missed", status: "Ended", endedAt: Date.now() }
    );

    // emit call_missed to receiver of call
    io.to(toUser?.socketId).emit("video_call_missed", {
      from,
      to,
    });
  });

  // handle video_call_accepted
  socket.on("video_call_accepted", async (data) => {
    const { to, from } = data;

    const fromUser = await User.findById(from);

    // find and update call record
    await VideoCall.findOneAndUpdate(
      {
        participants: { $size: 2, $all: [to, from] },
      },
      { verdict: "Accepted" }
    );

    // emit call_accepted to sender of call
    io.to(fromUser?.socketId).emit("video_call_accepted", {
      from,
      to,
    });
  });

  // handle video_call_denied
  socket.on("video_call_denied", async (data) => {
    // find and update call record
    const { to, from } = data;

    await VideoCall.findOneAndUpdate(
      {
        participants: { $size: 2, $all: [to, from] },
      },
      { verdict: "Denied", status: "Ended", endedAt: Date.now() }
    );

    const fromUser = await User.findById(from);
    // emit call_denied to sender of call

    io.to(fromUser?.socketId).emit("video_call_denied", {
      from,
      to,
    });
  });

  // handle user_is_busy_video_call
  socket.on("user_is_busy_video_call", async (data) => {
    const { to, from } = data;
    // find and update call record
    await VideoCall.findOneAndUpdate(
      {
        participants: { $size: 2, $all: [to, from] },
      },
      { verdict: "Busy", status: "Ended", endedAt: Date.now() }
    );

    const fromUser = await User.findById(from);
    // emit on_another_video_call to sender of call
    io.to(fromUser?.socketId).emit("on_another_video_call", {
      from,
      to,
    });
  });

  // -------------- HANDLE SOCKET DISCONNECTION ----------------- //
  socket.on("end", async (data) => {
    if (data.user_id) {
      // Find user by ID and set status as offline
      await User.findByIdAndUpdate(data.userId, { status: "Offline" });
    }
    // broadcast to all conversation rooms of this user that this user is offline (disconnected)

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
