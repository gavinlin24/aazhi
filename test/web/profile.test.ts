import { env as workerEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/index";
import type { Env } from "../../src/env";
import { mintMemberProof, mintToken, mintViewerToken, TOKEN_TTL_MS } from "../../src/web/token";
import { seedOuting } from "../fixtures/outings";
import { one, select, textOf } from "./html";

const db = workerEnv.DB;
const KEY = "profile-test-signing-key";

function env(): Env {
  return {
    DB: db,
    DISCORD_PUBLIC_KEY: "00",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: "app-1",
    ANTHROPIC_API_KEY: "unused",
    TOKEN_SIGNING_KEY: KEY,
  };
}

const viewerToken = (viewer = "gavin", guild = "guild-1", at = Date.now()) => mintViewerToken(guild, viewer, "Friday Table", KEY, at);
const get = (path: string) => app.request(path, {}, env());
const hrefOf = (a: { attrs: Record<string, string> }) => a.attrs.href!.replaceAll("&amp;", "&");

beforeEach(async () => {
  await db.prepare("DELETE FROM bills").run();
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 10);
  await seedOuting(db, {
    id: "a1",
    people: [["gavin", "Gavin"], ["marcus", "Marcus <b>"]],
    place: "Saigon Kitchen",
    billDate: thisMonth,
    items: [["Pho dac biet", 2000, ["gavin"]], ["Bun bo Hue", 3000, ["marcus"]]],
  });
  await seedOuting(db, {
    id: "z1",
    guild: "guild-2",
    channel: "chan-2",
    people: [["marcus", "Marc the Belayer"], ["theo", "Theo"]],
    place: "Crag Cafe",
    billDate: thisMonth,
    items: [["Toast", 9900, ["marcus"]], ["Eggs", 900, ["theo"]]],
  });
});

describe("who can open a server's pages", () => {
  it("opens the viewer's own profile and marks the page as uncacheable", async () => {
    const res = await get(`/g/guild-1?t=${await viewerToken()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await textOf(await res.text(), "h1")).toContain("Gavin");
  });

  it("refuses a missing, tampered or expired token and says to run /profile again", async () => {
    const stale = await viewerToken("gavin", "guild-1", Date.now() - TOKEN_TTL_MS - 1);
    for (const t of ["", "nonsense", `${await viewerToken()}x`, stale]) {
      const res = await get(`/g/guild-1?t=${t}`);
      expect(res.status, t).toBe(403);
      expect(await res.text()).toContain("/profile");
    }
  });

  it("refuses a bill token", async () => {
    const token = await mintToken("a1", "gavin", KEY, Date.now());
    expect((await get(`/g/guild-1?t=${token}`)).status).toBe(403);
    expect((await get(`/g/guild-1/boards?t=${token}`)).status).toBe(403);
  });

  it("will not let a viewer token open a bill or its API", async () => {
    const token = await viewerToken();
    expect((await get(`/b/a1?t=${token}`)).status).toBe(403);
    const state = (t: string) => app.request("/b/a1/state", { headers: { authorization: `Bearer ${t}` } }, env());
    expect((await state(token)).status).toBe(403);
    expect((await state(await mintToken("a1", "gavin", KEY, Date.now()))).status).toBe(200);
  });

  it("refuses a token from another server, on every page", async () => {
    const token = await viewerToken("gavin", "guild-2");
    for (const path of ["/g/guild-1", "/g/guild-1/boards", "/g/guild-1/u/marcus"]) {
      expect((await get(`${path}?t=${token}`)).status, path).toBe(403);
    }
  });

  it("refuses a typed id for someone with no bill here, the same whether or not they have bills elsewhere", async () => {
    const token = await viewerToken();
    const elsewhere = await get(`/g/guild-1/u/theo?t=${token}`);
    const nobody = await get(`/g/guild-1/u/someone-else?t=${token}`);
    expect(elsewhere.status).toBe(403);
    expect(nobody.status).toBe(403);
    const html = await elsewhere.text();
    expect(html).toBe(await nobody.text());
    expect(html).not.toMatch(/Theo|Crag|\$9/);
  });

  it("opens that person with the proof /profile @name gave, and no one else with it", async () => {
    const token = await viewerToken();
    const proof = await mintMemberProof(token, "theo", KEY);
    const res = await get(`/g/guild-1/u/theo?t=${token}&m=${proof}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(await textOf(html, "h1")).toContain("Theo");
    expect(await textOf(html, ".hero-amt")).toBe("$9.00");

    expect((await get(`/g/guild-1/u/kai?t=${token}&m=${proof}`)).status).toBe(403);
    const otherViewer = await viewerToken("marcus");
    expect((await get(`/g/guild-1/u/theo?t=${otherViewer}&m=${proof}`)).status).toBe(403);
    expect((await get(`/g/guild-1/u/theo?t=${token}&m=${proof}x`)).status).toBe(403);
    expect((await get(`/g/guild-1/u/theo?t=${token}&m=nonsense`)).status).toBe(403);
  });

  it("will not take a bill token or a viewer token as a proof", async () => {
    const token = await viewerToken();
    const billToken = await mintToken("a1", "theo", KEY, Date.now());
    for (const fake of [billToken, billToken.split(".")[1], token.split(".")[1]]) {
      expect((await get(`/g/guild-1/u/theo?t=${token}&m=${fake}`)).status, fake).toBe(403);
    }
  });
});

describe("the profile page", () => {
  it("shows the range with one hit area per month, and no seal strip", async () => {
    const html = await (await get(`/g/guild-1?t=${await viewerToken()}`)).text();
    expect(await textOf(html, ".hero-amt")).toBe("$20.00");
    expect(await textOf(html, ".hero-sub")).toBe("1 outing so far.");
    expect((await select(html, ".hit")).length).toBe(1);
    expect((await one(html, ".hit")).attrs["data-line"]).toMatch(/^\$20\.00 in [A-Z][a-z]+, 1 outing\.$/);
    expect(await select(html, ".chip-back")).toHaveLength(0);
    expect(await select(html, ".pair-card")).toHaveLength(0);
    expect(html).not.toMatch(/seal-strip|seal-card/);
  });

  it("says it counts every server, and names none of them", async () => {
    const html = await (await get(`/g/guild-1?t=${await viewerToken()}`)).text();
    expect(await textOf(html, ".meta")).toMatch(/^Every server · since [A-Z]/);
    expect(await textOf(html, ".head")).not.toContain("Friday Table");
  });

  it("adds the Back to you chip and the pair card on someone else's page", async () => {
    const token = await viewerToken();
    const html = await (await get(`/g/guild-1/u/marcus?t=${token}`)).text();
    expect((await one(html, ".chip-back")).attrs.href).toBe(`/g/guild-1?t=${token}`);
    expect(await textOf(html, ".pair-card .card-h")).toBe("You and Marcus &lt;b&gt;");
    expect((await select(html, ".fig")).map((f) => f.text)).toEqual(["1", "0", "1"]);
    expect(html).not.toContain("Marcus <b>");
  });

  it("gives a long name its own line and keeps it out of the narrow card label", async () => {
    await seedOuting(db, {
      id: "a2",
      people: [["gavin", "Gavin"], ["alex", "Alexandria Featherstonehaugh"]],
      billDate: new Date().toISOString().slice(0, 10),
      items: [["Pho", 2000, ["gavin"]], ["Bun", 3000, ["alex"]]],
    });
    const token = await viewerToken();
    const long = await (await get(`/g/guild-1/u/alex?t=${token}`)).text();
    expect((await one(long, ".head")).attrs.class).toContain("is-long");
    expect((await select(long, ".fl")).map((f) => f.text)).toContain("they hosted");
    expect(await textOf(long, ".pair-card .card-h")).toBe("You and Alexandria Featherstonehaugh");

    const short = await (await get(`/g/guild-1/u/marcus?t=${token}`)).text();
    expect((await one(short, ".head")).attrs.class).toBe("head");
  });

  it("moves a name off the tabs' line once it can't fit beside them", async () => {
    const people: [string, string][] = [["chris", "Christopher"], ["wei", "黄伟明明"], ["ming", "欧阳黄伟明明"]];
    for (const [id, name] of people) {
      await seedOuting(db, { id: `h-${id}`, people: [[id, name]], alongside: ["gavin", "Gavin"], items: [["Pho", 2000, [id]]] });
    }
    const token = await viewerToken();
    const classOf = async (id: string) => (await one(await (await get(`/g/guild-1/u/${id}?t=${token}`)).text(), ".head")).attrs.class;
    expect(await classOf("chris")).toContain("is-long");
    expect(await classOf("wei")).toBe("head");
    expect(await classOf("ming")).toContain("is-long");
  });

  it("links the companion tile to that person with the same token", async () => {
    const token = await viewerToken();
    const html = await (await get(`/g/guild-1?t=${token}`)).text();
    expect((await one(html, "a.tile2")).attrs.href).toBe(`/g/guild-1/u/marcus?t=${token}`);
  });

  it("treats a viewer's own id as their own page", async () => {
    const html = await (await get(`/g/guild-1/u/gavin?t=${await viewerToken()}`)).text();
    expect(await select(html, ".chip-back")).toHaveLength(0);
  });

  it("says no bills only when a proven link finds none anywhere", async () => {
    const token = await viewerToken();
    const html = await (await get(`/g/guild-1/u/priya?t=${token}&m=${await mintMemberProof(token, "priya", KEY)}`)).text();
    expect(await textOf(html, ".pair-none")).toBe("No bills yet.");
    expect(html).not.toContain("server yet");
  });

  it("adds someone up across servers, under the name from this one", async () => {
    const html = await (await get(`/g/guild-1/u/marcus?t=${await viewerToken()}`)).text();
    expect(await textOf(html, ".hero-amt")).toBe("$129.00");
    expect(await textOf(html, ".hero-sub")).toBe("2 outings so far.");
    expect(await textOf(html, "h1")).toContain("Marcus &lt;b&gt;");
    expect(html).toContain("Crag Cafe");
    expect(html).not.toContain("Belayer");
  });

  it("names a companion from another server with no way through to them", async () => {
    for (const id of ["z2", "z3"]) {
      await seedOuting(db, {
        id,
        guild: "guild-2",
        channel: "chan-2",
        people: [["theo", "Theo"], ["gavin", "Gavin"]],
        billDate: new Date().toISOString().slice(0, 10),
        items: [["Eggs", 900, ["theo", "gavin"]]],
      });
    }
    const token = await viewerToken();
    const html = await (await get(`/g/guild-1?t=${token}`)).text();
    expect(await select(html, "a.tile2")).toHaveLength(0);
    expect(html).toContain("Theo");
    expect(html).toContain("2 outings together");
    expect(await select(html, ".tile2 .go-ic")).toHaveLength(0);
    expect(html).not.toContain("/u/theo");
  });

  it("keeps the pair card cumulative when the two only met elsewhere", async () => {
    await seedOuting(db, {
      id: "z2",
      guild: "guild-2",
      channel: "chan-2",
      people: [["marcus", "Marc the Belayer"], ["gavin", "Gavin"]],
      billDate: new Date().toISOString().slice(0, 10),
      items: [["Eggs", 900, ["marcus", "gavin"]]],
    });
    const html = await (await get(`/g/guild-1/u/marcus?t=${await viewerToken()}`)).text();
    expect((await select(html, ".fig")).map((f) => f.text)).toEqual(["2", "1", "1"]);
  });

  it("tells a viewer with no bills so, and still lets them reach the leaderboard", async () => {
    const html = await (await get(`/g/guild-1?t=${await viewerToken("noor")}`)).text();
    expect(await textOf(html, ".pair-none")).toBe("You have no bills yet.");
    expect((await select(html, ".tabs a")).map((a) => a.text)).toEqual(["You", "Leaderboard"]);
  });
});

describe("the tabs", () => {
  const lit = async (html: string) => (await select(html, ".tabs.nav a.on")).map((a) => a.text);

  it("names them You and Leaderboard, and lights the page you're on", async () => {
    const token = await viewerToken();
    const self = await (await get(`/g/guild-1?t=${token}`)).text();
    expect((await select(self, ".tabs.nav a")).map((a) => a.text)).toEqual(["You", "Leaderboard"]);
    expect(await lit(self)).toEqual(["You"]);
    expect(await lit(await (await get(`/g/guild-1/boards?t=${token}`)).text())).toEqual(["Leaderboard"]);
  });

  it("lights neither on someone else's page", async () => {
    const token = await viewerToken();
    expect(await lit(await (await get(`/g/guild-1/u/marcus?t=${token}`)).text())).toEqual([]);
    const proof = await mintMemberProof(token, "priya", KEY);
    expect(await lit(await (await get(`/g/guild-1/u/priya?t=${token}&m=${proof}`)).text())).toEqual([]);
  });

  it("gives the Leaderboard page the long-name header", async () => {
    const html = await (await get(`/g/guild-1/boards?t=${await viewerToken()}`)).text();
    expect((await one(html, ".head")).attrs.class).toContain("is-long");
    expect(await textOf(html, "h1")).toBe("Leaderboard");
  });

  it("keeps the Leaderboard tab on the last board from every page", async () => {
    const token = await viewerToken();
    const place = "board=spent&span=all";
    const board = `/g/guild-1/boards?t=${token}&${place}`;
    const tabsOf = async (path: string) => (await select(await (await get(path)).text(), ".tabs.nav a")).map(hrefOf);

    expect(await tabsOf(board)).toEqual([`/g/guild-1?t=${token}&${place}`, board]);
    expect(await tabsOf(`/g/guild-1?t=${token}&${place}`)).toContain(board);
    expect(await tabsOf(`/g/guild-1/u/marcus?t=${token}&${place}&from=leaderboard`)).toContain(board);
  });
});

describe("coming back from a name on the board", () => {
  it("carries the board and span through the tap, and the chip returns there", async () => {
    const token = await viewerToken();
    const html = await (await get(`/g/guild-1/boards?t=${token}&board=spent&span=all`)).text();
    const row = hrefOf((await select(html, '[data-list="spent:all"] .rank-row'))[0]!);
    expect(row).toBe(`/g/guild-1/u/marcus?t=${token}&board=spent&span=all&from=leaderboard`);

    const friend = await (await get(row)).text();
    const chip = await one(friend, ".chip-back");
    expect(chip.text).toContain("Back to leaderboard");
    expect(hrefOf(chip)).toBe(`/g/guild-1/boards?t=${token}&board=spent&span=all`);
  });

  it("gives every list's rows that list's own board", async () => {
    const token = await viewerToken();
    const html = await (await get(`/g/guild-1/boards?t=${token}`)).text();
    const hidden = (await select(html, '[data-list="visits:all"] .rank-row')).map(hrefOf);
    expect(hidden).toContain(`/g/guild-1/u/marcus?t=${token}&board=visits&span=all&from=leaderboard`);
  });

  it("keeps the board for your own row, which has no chip to read", async () => {
    const token = await viewerToken();
    const html = await (await get(`/g/guild-1/boards?t=${token}&board=spent&span=all`)).text();
    const mine = hrefOf(await one(html, '[data-list="spent:all"] .is-me .rank-row'));
    expect(mine).toBe(`/g/guild-1?t=${token}&board=spent&span=all`);
    expect(await select(await (await get(mine)).text(), ".chip-back")).toHaveLength(0);
  });

  it("still says Back to you for a friend opened from your own page", async () => {
    const token = await viewerToken();
    const self = await (await get(`/g/guild-1?t=${token}&board=spent&span=all`)).text();
    const tile = hrefOf(await one(self, "a.tile2"));
    expect(tile).toBe(`/g/guild-1/u/marcus?t=${token}&board=spent&span=all`);
    const friend = await (await get(tile)).text();
    expect((await one(friend, ".chip-back")).text).toContain("Back to you");
  });
});

describe("the boards page", () => {
  it("renders every board and span, with one showing", async () => {
    const html = await (await get(`/g/guild-1/boards?t=${await viewerToken()}`)).text();
    const lists = await select(html, "[data-list]");
    expect(lists.map((l) => l.attrs["data-list"])).toEqual([
      "hosted:month",
      "hosted:all",
      "spent:month",
      "spent:all",
      "visits:month",
      "visits:all",
    ]);
    expect(lists.filter((l) => !("hidden" in l.attrs)).map((l) => l.attrs["data-list"])).toEqual(["hosted:month"]);
  });

  it("opens the board and span the address names, and ignores a bad one", async () => {
    const t = await viewerToken();
    const pick = async (query: string) => {
      const html = await (await get(`/g/guild-1/boards?t=${t}&${query}`)).text();
      return (await select(html, "[data-list]")).filter((l) => !("hidden" in l.attrs)).map((l) => l.attrs["data-list"]);
    };
    expect(await pick("board=spent&span=all")).toEqual(["spent:all"]);
    expect(await pick("board=nonsense&span=nonsense")).toEqual(["hosted:month"]);
  });

  it("marks the viewer's row and links each name to a profile", async () => {
    const token = await viewerToken();
    const html = await (await get(`/g/guild-1/boards?t=${token}&board=spent`)).text();
    const rows = await select(html, '[data-list="spent:month"] .rank-row');
    expect(rows.map(hrefOf)).toEqual([`/g/guild-1/u/marcus?t=${token}&board=spent&span=month&from=leaderboard`, `/g/guild-1?t=${token}&board=spent&span=month`]);
    expect((await one(html, '[data-list="spent:month"] .is-me')).text).toContain("you");
  });

  it("gives the top three a seal numeral and anyone lower a plain number", async () => {
    for (const [i, id] of ["ann", "bo", "cy", "di"].entries()) {
      await seedOuting(db, {
        id: `r${i}`,
        people: [[id, id.toUpperCase()]],
        alongside: ["gavin", "Gavin"],
        items: [["A", 1000 * (10 - i), [id]]],
        billDate: new Date().toISOString().slice(0, 10),
      });
    }
    const html = await (await get(`/g/guild-1/boards?t=${await viewerToken()}&board=spent`)).text();
    const list = '[data-list="spent:month"]';
    expect((await select(html, `${list} .sl text`)).map((t) => t.text)).toEqual(["一", "二", "三"]);
    expect((await select(html, `${list} .rk`)).map((t) => t.text)).toEqual(["4", "5", "6"]);
  });

  it("says so when a board has nobody on it", async () => {
    const html = await (await get(`/g/guild-1/boards?t=${await viewerToken()}`)).text();
    expect((await select(html, '[data-list="hosted:all"] .rank-row .nm')).map((n) => n.text).join()).toContain("Gavin");
    await db.prepare("DELETE FROM bills").run();
    const empty = await (await get(`/g/guild-1/boards?t=${await viewerToken()}`)).text();
    expect(await textOf(empty, '[data-list="hosted:all"] .pair-none')).toBe("Nobody is on this board yet.");
  });

  it("lists this server's people with their whole totals, and says so", async () => {
    const html = await (await get(`/g/guild-1/boards?t=${await viewerToken()}&board=spent`)).text();
    expect(html).toContain("$129.00");
    expect(html).not.toMatch(/Belayer|Theo/);
    expect((await select(html, ".foot")).map((f) => f.text)).toContain("Totals include meals in other servers.");
  });

  it("calls the third board Places", async () => {
    const html = await (await get(`/g/guild-1/boards?t=${await viewerToken()}`)).text();
    expect((await select(html, ".tabs.wide a")).map((a) => a.text)).toEqual(["Hosted", "Spent", "Places"]);
    expect(html).not.toContain("Unique visits");
  });

  it("moves Month and All time into each card header, leaving two rows of tabs", async () => {
    const t = await viewerToken();
    const html = await (await get(`/g/guild-1/boards?t=${t}&board=spent&span=all`)).text();
    expect(await select(html, "div.tabs")).toHaveLength(1);
    const spans = await select(html, '[data-list="spent:all"] .card-h .tabs.span a');
    expect(spans.map((a) => a.text)).toEqual(["Month", "All time"]);
    expect(hrefOf(spans[0]!)).toBe(`/g/guild-1/boards?t=${t}&board=spent&span=month`);
    expect(spans[1]!.attrs.class).toBe("on");
  });

  it("sends an expired link back to /leaderboard", async () => {
    const res = await get(`/g/guild-1/boards?t=${await viewerToken("gavin", "guild-1", Date.now() - TOKEN_TTL_MS - 1)}`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("/leaderboard");
  });

  it("carries the server's name, and copes without it", async () => {
    const named = await (await get(`/g/guild-1/boards?t=${await viewerToken()}`)).text();
    expect(await textOf(named, ".meta")).toContain("Friday Table");
    const token = await mintViewerToken("guild-1", "gavin", null, KEY, Date.now());
    const plain = await (await get(`/g/guild-1/boards?t=${token}`)).text();
    expect(await textOf(plain, ".meta")).toBe("This server");
  });
});
