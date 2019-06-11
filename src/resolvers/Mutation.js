const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomBytes } = require("crypto");
const { promisify } = require("util");
const { transport, makeANiceEmail } = require("../mail");

const Mutations = {
  //--------------------Signup Mutation--------------------//
  async signup(parent, args, ctx, info) {
    // lowercase their email
    args.email = args.email.toLowerCase();
    // hash their password
    const password = await bcrypt.hash(args.password, 10);
    // create the user in the database
    const user = await ctx.db.mutation.createUser(
      {
        data: {
          ...args,
          password,
          permissions: { set: ["USER"] }
        }
      },
      info
    );
    // create the JWT token for them
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    // We set the jwt as a cookie on the response
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365 // 1 year cookie
    });
    // Finalllllly we return the user to the browser
    return user;
  },
  //--------------------Signin Mutation--------------------//
  async signin(parent, { email, password }, ctx, info) {
    // 1. check if there is a user with that email
    const user = await ctx.db.query.user({ where: { email } });
    if (!user) {
      throw new Error(`No such user found for email ${email}`);
    }
    // 2. Check if their password is correct
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new Error("Invalid Password!");
    }
    // 3. generate the JWT Token
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    // 4. Set the cookie with the token
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });
    // 5. Return the user
    return user;
  },
  //--------------------Signout Mutation--------------------//
  signout(parent, args, ctx, info) {
    ctx.response.clearCookie("token");
    return { message: "Goodbye!" };
  },
  //--------------------Reset Password--------------------//
  async requestReset(parent, args, ctx, info) {
    // 1. Check if this is a real user
    const user = await ctx.db.query.user({ where: { email: args.email } });
    if (!user) {
      throw new Error(`No such user found for email ${args.email}`);
    }
    // 2. Set a reset token and expiry on that user
    const randomBytesPromiseified = promisify(randomBytes);
    const resetToken = (await randomBytesPromiseified(20)).toString("hex");
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour from now
    const res = await ctx.db.mutation.updateUser({
      where: { email: args.email },
      data: { resetToken, resetTokenExpiry }
    });

    const mailRes = await transport.sendMail({
      from: "wes@wesbos.com",
      to: user.email,
      subject: "Your Password Reset Token",
      html: makeANiceEmail(`Your Password Reset Token is here!
          \n\n
          <a href="${
            process.env.FRONTEND_URL
          }/reset?resetToken=${resetToken}">Click Here to Reset</a>`)
    });

    // 4. Return the message
    return { message: "Thanks!" };
    // 3. Email them that reset token
  },
  //--------------------Reset Password input Mutation--------------------//
  async resetPassword(parent, args, ctx, info) {
    // 1. check if the passwords match
    if (args.password !== args.confirmPassword) {
      throw new Error("Yo Passwords don't match!");
    }
    // 2. check if its a legit reset token
    // 3. Check if its expired
    const [user] = await ctx.db.query.users({
      where: {
        resetToken: args.resetToken,
        resetTokenExpiry_gte: Date.now() - 3600000
      }
    });
    if (!user) {
      throw new Error("This token is either invalid or expired!");
    }
    // 4. Hash their new password
    const password = await bcrypt.hash(args.password, 10);
    // 5. Save the new password to the user and remove old resetToken fields
    const updatedUser = await ctx.db.mutation.updateUser({
      where: { email: user.email },
      data: {
        password,
        resetToken: null,
        resetTokenExpiry: null
      }
    });
    // 6. Generate JWT
    const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET);
    // 7. Set the JWT cookie
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });
    // 8. return the new user
    return updatedUser;
  },
  //--------------------Update User Profile--------------------//
  updateUser(parent, args, ctx, info) {
    // first take a copy of the updates
    const updates = { ...args };
    // remove the ID from the updates
    delete updates.id;
    // run the update method
    return ctx.db.mutation.updateUser(
      {
        data: updates,
        where: {
          id: args.id
        }
      },
      info
    );
  },
  //--------------------Questions--------------------//

  async createQuestion(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must be logged in to do that!");
    }

    const question = await ctx.db.mutation.createQuestion(
      {
        data: {
          // This is how to create a relationship between the Item and the User
          askedBy: {
            connect: {
              id: ctx.request.userId
            }
          },
          ...args,
          tags: { connect: args.tags }
        }
      },
      info
    );

    console.log(question);
    return question;
  },

  async createQuestionView(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must be logged in to do that!");
    }
    const views = await ctx.db.query.questionViews({
      where: {
        viewedBy: { id: ctx.request.userId },
        viewedQuestion: { id: args.questionId }
      }
    });

    if (views.length === 0) {
      const question = await ctx.db.mutation.createQuestionView({
        data: {
          // This is how to create a relationship between the Item and the User
          viewedBy: {
            connect: {
              id: ctx.request.userId
            }
          },
          viewedQuestion: {
            connect: {
              id: args.questionId
            }
          }
        }
      });
    }

    return true;
  },

  createTag: async (parent, args, ctx, info) => {
    const name = args.name.trim().toLowerCase();
    const exists = await ctx.db.query.tags({ name });

    if (exists !== name && name.length >= 2) {
      const newTag = await ctx.db.mutation.createTag({
        data: {
          name: name
        }
      });

      return newTag;
    }
  },

  createAnswer: async (parent, args, ctx, info) => {
    if (!ctx.request.userId) {
      throw new Error("You must be logged in to do that!");
    }
    console.log(args.id);
    const newAnswer = await ctx.db.mutation.createAnswer({
      data: {
        body: args.body,
        answeredBy: { connect: { id: ctx.request.userId } },
        answeredTo: { connect: { id: args.questionId } }
      }
    });

    return newAnswer;
  }
};

module.exports = Mutations;
