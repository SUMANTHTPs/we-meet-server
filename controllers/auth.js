const jwt = require("jsonwebtoken");
const User = require("../models/user");
const filterObj = require("../utils/filterObj");
const otpGenerator = require("otp-generator");
const crypto = require("crypto");
const { promisify } = require("util");

const signToken = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET);

// Register new user
exports.register = async (req, res, next) => {
  const { firstName, lastName, email, password } = req.body;

  const filteredBody = filterObj(
    req.body,
    "firstName",
    "lastName",
    "password",
    "email"
  );

  // check if email is already present
  const existingUser = await User.findOne({ email: email });

  if (existingUser && existingUser.verified) {
    res.status(400).json({
      status: "error",
      message: "Email is already in use, Please login",
    });
  } else if (existingUser) {
    const updatedUser = await User.findOneAndUpdate(
      { email: email },
      filteredBody,
      {
        new: true,
        validateModifiedOnly: true,
      }
    );

    //
    req.userId = existingUser._id;
    next();
  } else {
    // if user record is not available in DB
    const newUser = await User.create(filteredBody);

    // generate OTP and send mail to user
    req.userId = newUser._id;

    next();
  }
};

// send OTP
exports.sendOTP = async (req, res, next) => {
  const { userId } = req;
  const newOtp = otpGenerator.generate(6, {
    lowerCaseAlphabets: false,
    upperCaseAlphabets: false,
    specialChars: false,
  });

  const otpExpiryTime = Date.now() + 10 * 60 * 1000; // 10 min  timeout

  await User.findByIdAndUpdate(userId, {
    otp: newOtp,
    otpExpiryTime,
  });

  // TODO: Send mail
  res.status(200).json({
    status: "success",
    message: "OTP sent successfully",
  });
};

//  verifyOTP

exports.verifyOTP = async (req, res, next) => {
  const { email, otp } = req.body;

  const user = await User.findOne({
    email,
    otpExpiryTime: { $gt: Date.now() },
  });

  if (!user) {
    res.status(400).json({
      status: "error",
    });
  }

  if (!(await user.correctOTP(otp, user.otp))) {
    res.status(400).json({
      status: "error",
      message: "OTP is incorrect",
    });
  }

  // OTP is correct

  user.verified = true;
  user.otp = undefined;

  await user.save({ new: true, validateModifiedOnly: true });

  const token = signToken(user._id);

  res.status(200).json({
    status: "success",
    message: "OTP verified successfully",
    token,
  });
};

// login
exports.login = async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({
      status: "error",
      message: "Both email and password are required",
    });
  }

  const userDoc = await User.findOne({ email: email }).select("+password");

  if (!userDoc || (await userDoc.correctPassword(password, user.password))) {
    res.status(400).json({
      status: "error",
      message: "Email is incorrect",
    });
  }

  const token = signToken(userDoc._id);

  res.status(200).json({
    status: "success",
    message: "Logged in successfully",
    token,
  });
};

// Types of routes
// Protected and unprotected
exports.protect = async (req, res, next) => {
  // Getting the token (JWT) and check if it's there

  let token;

  // Bearer token like 'Bearer somethingTOken1234'
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  } else {
    req.status(400).json({
      status: "error",
      message: "You are not authorized, try again",
    });
    return;
  }

  // verification of token

  const decoded = await promisify(jwt.verify(token, process.env.JWT_SECRET));

  // check if user still exist

  const thisUser = await User.findById(decoded.userId);

  if (!thisUser) {
    res.status(400).json({
      status: "error",
      message: "The user doesn't exist",
    });
  }

  // Check if user changed their password after token was issued

  if (thisUser.changedPasswordAfter(decoded.iat)) {
    res.status(400).json({
      status: "error",
      message: "User recently updated password! Please login again",
    });
  }

  req.user = thisUser;
  next();
};

exports.forgotPassword = async (req, res, next) => {
  //Get user email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    res.status(400).json({
      status: "error",
      message: "There is no user with this email address",
    });
    return;
  }
  // Generate the random reset token
  const resetToken = user.createPasswordToken();

  const resetURL = `https://wemeet.com/auth/reset-password/?code=${resetToken}`;
  try {
    // TODO => Send email with reset URL

    res.status(200).json({
      status: "success",
      message: "Reset password link sent to Email",
    });
  } catch (error) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;

    await user.save({ validateBeforeSave: false });

    res.status(500).json({
      status: "error",
      message: "There was an error sending the email, please try again",
    });
  }
};

exports.resetPassword = async (req, res, next) => {
  // get the user based on token
  const hashedToken = crypto
    .createHash("sha256")
    .update(req.params.token)
    .digest("hex");

  const user = await user.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  // 2. If token has expired or submission out of time

  if (!user) {
    res.status(400).json({
      status: "error",
      message: "Token in invalid or expired",
    });
    return;
  }

  // Update user password
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;

  await user.save();

  // Login user and send token

  // TODO => send an email to inform about password change

  const token = signToken(user._id);

  res.status(200).json({
    status: "success",
    message: "Password changed successfully",
    token,
  });
};
