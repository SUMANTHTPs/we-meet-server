const jwt = require("jsonwebtoken");
const otpGenerator = require("otp-generator");
const crypto = require("crypto");
const { promisify } = require("util");
const sendEmail = require("../services/mailer");

const User = require("../models/user");
const filterObj = require("../utils/filterObj");
const otp = require("../Templates/Mail/otp");
const resetPassword = require("../Templates/Mail/resetPassword");

const signToken = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET);

// Register new user
exports.register = async (req, res, next) => {
  const { firstName, lastName, email, password } = req.body;

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({
      status: "error",
      message: "All the fields are mandatory",
    });
  }

  const filteredBody = filterObj(
    req.body,
    "firstName",
    "lastName",
    "email",
    "password"
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

    // await newUser.save();

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

  const user = await User.findByIdAndUpdate(userId, {
    otpExpiryTime,
  });

  user.otp = newOtp.toString();

  await user.save({ new: true, validateModifiedOnly: true });
  console.log(newOtp);

  // TODO: Send mail

  sendEmail(
    user.email,
    "We meet OTP verification",
    "",
    otp(user.firstName ?? "User", newOtp)
  );
  res.status(200).json({
    status: "success",
    message: "OTP sent successfully",
  });
};

//  verify OTP
exports.verifyOTP = async (req, res, next) => {
  const { email, otp } = req.body;

  const user = await User.findOne({
    email,
    otpExpiryTime: { $gt: Date.now() },
  });

  if (!user) {
    return res.status(400).json({
      status: "error",
      message: "Email is invalid or OTP expired",
    });
  }

  if (user.verified) {
    return res.status(400).json({
      status: "error",
      message: "OTP is incorrect",
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

  // if (!userDoc.verified) {
  //   return res.status(400).json({
  //     status: "error",
  //     message: "Registration incomplete, register again",
  //   });
  // }

  if (
    !userDoc ||
    !(await userDoc.correctPassword(password, userDoc.password))
  ) {
    console.log(await userDoc.correctPassword(password, userDoc.password));
    res.status(400).json({
      status: "error",
      message: "Email or password is incorrect",
    });
    return;
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

  // Bearer token like 'Bearer someToken1234'
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  }

  if (!token) {
    return next(
      new AppError(`You are not logged in! Please log in to get access.`, 401)
    );
  }

  // verification of token

  const decoded = await promisify(jwt.verify(token, process.env.JWT_SECRET));

  // check if user still exist

  const thisUser = await User.findById(decoded.userId);

  if (!thisUser) {
    return next(
      new AppError(
        "The user belonging to this token does no longer exists.",
        401
      )
    );
  }

  // Check if user changed their password after token was issued

  if (thisUser.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError("User recently changed password! Please log in again.", 401)
    );
  }

  // GRANT ACCESS TO PROTECTED ROUTE
  req.user = thisUser;
  next();
};

exports.forgotPassword = async (req, res, next) => {
  //Get user email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return res.status(400).json({
      status: "error",
      message: "There is no user with this email address",
    });
  }
  // Generate the random reset token
  const resetToken = user.createPasswordToken();

  const resetURL = `http://localhost:3000/auth/reset-password/?code=${resetToken}`;
  try {
    //Send email with reset URL
    sendEmail(
      user.email,
      "We meet OTP to reset password",
      "",
      resetPassword(user.firstName ?? "User", resetURL)
    );

    res.status(200).json({
      status: "success",
      message: "Reset password link sent to Email",
    });
  } catch (error) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;

    await user.save({ validateBeforeSave: false });

    return next(
      new AppError("There was an error sending the email. Try again later!"),
      500
    );
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
    return res.status(400).json({
      status: "error",
      message: "Token in invalid or expired",
    });
  }

  // Update user password
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;

  await user.save();

  // Login user and send token

  // send an email to inform about password sendEmail(
  sendEmail(
    user.email,
    "Your password is successfully changed",
    "Your changed the password  just now. Let us know if you didn't did this",
    ""
  );

  const token = signToken(user._id);

  res.status(200).json({
    status: "success",
    message: "Password changed successfully",
    token,
  });
};
