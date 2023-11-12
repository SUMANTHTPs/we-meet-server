const nodemailer = require("nodemailer");
const fs = require("fs")

// Create a transporter using Gmail SMTP
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "wemeetbysumanth@gmail.com",
    pass: "xwqyfhqkulkjryux",
  },
});

const sendEmail = (to, subject, text, htmlPath, attachments) => {
  const mailOptions = {
    from: "wemeetbysumanth@gmail.com",
    to,
    subject,
    text,
    html: htmlPath,
    attachments
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error("Error sending email:", error);
    } else {
      console.log("Email sent:", info.response);
    }
  });
};

module.exports = sendEmail;
