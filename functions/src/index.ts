import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as express from "express";
import { IncomingWebhook } from "@slack/client";
import { WebClient, LogLevel } from "@slack/web-api";

const token = "xoxb-206738575397-3099612523716-Dwwl2wbNtCWwWWpLSAXRdrVv";
const client = new WebClient(token, {
  logLevel: LogLevel.DEBUG,
});

const app = express();
admin.initializeApp(functions.config().firebase);
const firestore = admin.firestore();

const dynamic = "Dynamic";
const essential = "Essential";
const buddy = "Buddy";
const tentialValues = [dynamic, essential, buddy];

const formatSlackUrl = (channel: string, ts: string) => {
  return `https://tential.slack.com/archives/${channel}/p${ts.replace(
    ".",
    ""
  )}`;
};

app.post("/", async (req, res) => {
  const reaction = req.body.event.reaction;
  const values = tentialValues.map((value) => value.toLowerCase());
  const eventType = req.body.event.type;
  if (eventType === "reaction_added" && values.includes(reaction)) {
    const docs = await firestore
      .collection("reactions")
      .where("event.event_ts", "==", req.body.event.event_ts)
      .get()
      .then(async (snapshot) => {
        return snapshot.docs;
      });
    if (docs.length === 0) {
      const ts = req.body.event.event_ts.replace(".", "");
      await firestore.collection("reactions").doc(ts).set(req.body);
    }
  } else if (eventType === "reaction_removed" && values.includes(reaction)) {
    const user = req.body.event.user;
    const channel = req.body.event.item.channel;
    const ts = req.body.event.item.ts;
    await firestore
      .collection("reactions")
      .where("event.user", "==", user)
      .where("event.item.channel", "==", channel)
      .where("event.item.ts", "==", ts)
      .where("event.reaction", "==", reaction)
      .get()
      .then(async (snapshot) => {
        const ids = snapshot.docs.map((doc) => doc.id);
        for (const id of ids) {
          await firestore.collection("reactions").doc(id).delete();
        }
      });
  }

  res.status(200);
  return res.send("success");
});

type Receiver = {
  channel: string;
  ts: string;
  item_user: string;
};

const getByValue = async (value: string, unix: number) => {
  const records = await firestore
    .collection("reactions")
    .where("event_time", ">=", unix)
    .where("event.reaction", "==", value.toLowerCase())
    .get()
    .then(async (snapshot) => {
      return snapshot.docs.map((doc) => doc.data());
    });

  const receiverCounter: [Receiver, number][] = [];
  const giverCounter: [string, number][] = [];
  if (records.length !== 0) {
    const event2Receiver = (event: any): Receiver => {
      return {
        channel: event.item.channel,
        ts: event.item.ts,
        item_user: event.item_user,
      };
    };
    const event2User = (event: any) => {
      return event.user;
    };

    records.forEach((record) => {
      const receiver = event2Receiver(record.event);
      const receiverEl = receiverCounter.find(
        (el) =>
          el[0].channel === receiver.channel &&
          el[0].ts === receiver.ts &&
          el[0].item_user === receiver.item_user
      );
      const user = event2User(record.event);
      const giverEl = giverCounter.find((el) => el[0] === user);
      if (receiverEl) {
        receiverCounter[receiverCounter.indexOf(receiverEl)] = [
          receiver,
          receiverCounter[receiverCounter.indexOf(receiverEl)][1] + 1,
        ];
      } else {
        receiverCounter.push([receiver, 1]);
      }
      if (giverEl) {
        giverCounter[giverCounter.indexOf(giverEl)] = [
          user,
          giverCounter[giverCounter.indexOf(giverEl)][1] + 1,
        ];
      } else {
        giverCounter.push([user, 1]);
      }
    });

    receiverCounter.sort((a, b) => b[1] - a[1]);
    giverCounter.sort((a, b) => b[1] - a[1]);
  }

  return {
    receiverCounter,
    giverCounter,
  };
};

app.post("/daily", async (req, res) => {
  try {
    const now = Date.now();
    const yesterday = now - 1 * 1000 * 60 * 60 * 24;
    const unix = Math.floor(yesterday / 1000);

    const texts: string[] = [];

    for (const value of tentialValues) {
      const { receiverCounter, giverCounter } = await getByValue(value, unix);

      if (receiverCounter.length >= 1) {
        const receiveCounts: number[] = [];
        let text = `今日もっとも:${value.toLowerCase()}:のスタンプ貰った人はこの人です！\n\n`;
        for (let i = 0; i <= 100; i++) {
          const el = receiverCounter[i];
          if (!el) break;

          const receiveCount = el[1];
          if (!receiveCounts.includes(receiveCount)) {
            if (receiveCounts.length === 1) break;
            receiveCounts.push(receiveCount);
            text += `${receiveCounts.length}位\n`;
            text += `${receiveCount}${value} ${i === 0 ? ":tada:" : ""}\n`;
          }

          const channel = el[0].channel;
          const ts = el[0].ts;
          const user = el[0].item_user;

          text += `<@${user}>\n`;
          text += `${formatSlackUrl(channel, ts)} \n\n`;
        }

        const giveCounts: number[] = [];
        text += `\n今日もっとも:${value.toLowerCase()}:のスタンプ送った送った人はこの人です！\n`;
        for (let i = 0; i <= 100; i++) {
          const el = giverCounter[i];
          if (!el) break;

          const giveCount = el[1];
          if (!giveCounts.includes(giveCount)) {
            if (giveCounts.length === 1) break;
            giveCounts.push(giveCount);
            text += `\n${giveCounts.length}位\n`;
            text += `${giveCount}${value} ${i === 0 ? ":tada:" : ""}\n`;
          }

          const user = el[0];
          text += `<@${user}>\n`;
        }

        const webhook = new IncomingWebhook(
          "https://hooks.slack.com/services/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"
        );

        texts.push(text);

        const payload = {
          text,
          unfurl_links: true,
        };

        webhook.send(payload);
      }
    }

    res.status(200);
    return res.json({
      texts,
    });
  } catch (e) {
    console.error(e);
    res.status(400);
    return res.send(e);
  }
});

app.get("/monthly", async (req, res) => {
  try {
    const date = new Date();
    date.setDate(1);
    const unix = Math.floor(date.getTime() / 1000);

    // const res: Record<
    //   typeof tentialValues[number],
    //   { receiver: [string, number][]; giver: [string, string] }
    // > = {};
    const response: Record<
      typeof tentialValues[number],
      // { receiver: [string, number][]; giver: [string, string] }
      any
    > = {};

    const result = await client.users.list({
      token,
    });
    if (!result.members) return res.send("success");

    const users: Record<string, string> = {};
    result.members.forEach((member) => {
      if (member.id && member.real_name) {
        users[member.id] = member.real_name;
      }
    });
    console.log(users);

    for (const value of tentialValues) {
      const { receiverCounter, giverCounter } = await getByValue(value, unix);
      const receivers: {
        user: string;
        url: string;
        count: number;
      }[] = receiverCounter.map((receiver) => {
        return {
          user: users[receiver[0].item_user],
          url: formatSlackUrl(receiver[0].channel, receiver[0].ts),
          count: receiver[1],
        };
      });

      const givers: {
        user: string;
        count: number;
      }[] = giverCounter.map((giver) => {
        return {
          user: users[giver[0]],
          count: giver[1],
        };
      });
      response[value] = {
        receivers,
        givers,
      };
    }

    res.status(200);
    return res.json(response);
  } catch (e) {
    console.error(e);
    res.status(400);
    return res.send(e);
  }
});

export const api = functions.https.onRequest(app);
