// import { getPreDecodedNetworth } from "skyhelper-networth";
import sanitize from "mongo-sanitize";
import retry from "async-retry";
import axios from "axios";

import * as constants from "./constants.js";
import credentials from "./credentials.js";
import * as helper from "./helper.js";
import * as stats from "./stats.js";

const hypixel = axios.create({
  baseURL: "https://api.hypixel.net/",
});

export async function getStats(
  db,
  profile,
  bingoProfile,
  allProfiles,
  items,
  packs,
  options = { cacheOnly: false, debugId: `${helper.getClusterId()}/unknown@getStats` }
) {
  const output = {};

  console.debug(`${options.debugId}: getStats called.`);
  const timeStarted = Date.now();

  const userProfile = profile.members[profile.uuid];
  const hypixelProfile = await helper.getRank(profile.uuid, db, options.cacheOnly);

  output.stats = Object.assign({}, constants.BASE_STATS);

  output.fairy_souls = stats.getFairySouls(userProfile, profile);

  output.skills = await stats.getSkills(userProfile, hypixelProfile, profile.members);

  output.slayer = stats.getSlayer(userProfile);

  output.base_stats = Object.assign({}, output.stats);

  output.kills = stats.getKills(userProfile);
  output.deaths = stats.getDeaths(userProfile);

  const playerObject = await helper.resolveUsernameOrUuid(profile.uuid, db, options.cacheOnly);

  output.display_name = playerObject.display_name;

  if ("wardrobe_equipped_slot" in userProfile) {
    output.wardrobe_equipped_slot = userProfile.wardrobe_equipped_slot;
  }

  const userInfo = await db.collection("usernames").findOne({ uuid: profile.uuid });

  const memberUuids = [];
  for (const [uuid, memberProfile] of Object.entries(profile?.members ?? {})) {
    if (memberProfile?.coop_invitation?.confirmed === false || memberProfile.deletion_notice?.timestamp !== undefined) {
      memberProfile.removed = true;
    }

    memberUuids.push(uuid);
  }

  const members = await Promise.all(
    memberUuids.map(async (a) => {
      return {
        ...(await helper.resolveUsernameOrUuid(a, db, options.cacheOnly)),
        removed: profile.members[a]?.removed || false,
      };
    })
  );

  if (userInfo) {
    output.display_name = userInfo.username;

    members.push({
      uuid: profile.uuid,
      display_name: userInfo.username,
      removed: profile.members[profile.uuid]?.removed || false,
    });

    if ("emoji" in userInfo) {
      output.display_emoji = userInfo.emoji;
    }

    if ("emojiImg" in userInfo) {
      output.display_emoji_img = userInfo.emojiImg;
    }

    if (userInfo.username == "jjww2") {
      output.display_emoji = constants.randomEmoji();
    }
  }

  output.guild = await helper.getGuild(profile.uuid, db, options.cacheOnly);

  output.rank_prefix = helper.renderRank(hypixelProfile);
  output.uuid = profile.uuid;
  output.skin_data = playerObject.skin_data;

  output.profile = { profile_id: profile.profile_id, cute_name: profile.cute_name, game_mode: profile.game_mode };
  output.profiles = {};

  for (const sbProfile of allProfiles.filter((a) => a.profile_id != profile.profile_id)) {
    output.profiles[sbProfile.profile_id] = {
      profile_id: sbProfile.profile_id,
      cute_name: sbProfile.cute_name,
      game_mode: sbProfile.game_mode,
    };
  }

  output.members = members.filter((a) => a.uuid != profile.uuid);

  output.minions = stats.getMinions(profile);

  output.bestiary = stats.getBestiary(userProfile);

  output.social = hypixelProfile.socials;

  output.dungeons = await stats.getDungeons(userProfile, hypixelProfile);

  output.fishing = stats.getFishing(userProfile);

  output.farming = stats.getFarming(userProfile);

  output.enchanting = stats.getEnchanting(userProfile);

  output.mining = await stats.getMining(userProfile, hypixelProfile);

  output.crimson_isle = stats.getCrimsonIsle(userProfile);

  output.collections = await stats.getCollections(
    profile.uuid,
    profile,
    output.dungeons,
    output.crimson_isle,
    options.cacheOnly
  );

  output.skyblock_level = await stats.getSkyBlockLevel(userProfile);

  output.visited_zones = userProfile.player_data.visited_zones || [];

  output.visited_modes = userProfile.player_data.visited_modes || [];

  output.perks = userProfile.player_data.perks || {};

  output.harp_quest = userProfile.quests?.harp_quest || {};

  output.misc = stats.getMisc(profile, userProfile, hypixelProfile);

  output.bingo = stats.getBingoData(bingoProfile);

  output.user_data = stats.getUserData(userProfile);

  output.currencies = stats.getCurrenciesData(userProfile, profile);

  output.weight = stats.getWeight(output);

  output.accessories = await stats.getMissingAccessories(output, items, packs);

  output.networth = /*await getPreDecodedNetworth(
    userProfile,
    {
      armor: items.armor,
      equipment: items.equipment,
      wardrobe: items.wardrobe_inventory,
      inventory: items.inventory,
      enderchest: items.enderchest,
      accessories: items.accessory_bag,
      personal_vault: items.personal_vault,
      storage: items.storage.concat(items.storage.map((item) => item.containsItems).flat()),
      fishing_bag: items.fishing_bag,
      potion_bag: items.potion_bag,
      candy_inventory: items.candy_bag,
    },
    output.bank,
    { cache: true, onlyNetworth: true }
  )*/ {};

  output.temp_stats = stats.getTempStats(userProfile);

  output.rift = stats.getRift(userProfile);

  output.pets = await stats.getPets(userProfile, output, items, profile);

  console.debug(`${options.debugId}: getStats returned. (${Date.now() - timeStarted}ms)`);

  return output;
}

export async function getProfile(
  db,
  paramPlayer,
  paramProfile,
  options = { cacheOnly: false, debugId: `${helper.getClusterId()}/unknown@getProfile` }
) {
  console.debug(`${options.debugId}: getProfile called.`);
  const timeStarted = Date.now();

  if (paramPlayer.length != 32) {
    try {
      const { uuid } = await helper.resolveUsernameOrUuid(paramPlayer, db);

      paramPlayer = uuid;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  if (paramProfile) {
    paramProfile = paramProfile.toLowerCase();
  }

  const params = {
    key: credentials.hypixel_api_key,
    uuid: paramPlayer,
  };

  let allSkyBlockProfiles = [];

  let profileObject = await db.collection("profileStore").findOne({ uuid: sanitize(paramPlayer) });

  let lastCachedSave = 0;

  if (profileObject) {
    const profileData = db
      .collection("profileCache")
      .find({ profile_id: { $in: Object.keys(profileObject.profiles) } });
    for await (const doc of profileData) {
      if (doc.members?.[paramPlayer] == undefined) {
        continue;
      }

      Object.assign(doc, profileObject.profiles[doc.profile_id]);

      allSkyBlockProfiles.push(doc);
    }
  } else {
    profileObject = { last_update: 0 };
  }

  let response = null;

  lastCachedSave = Math.max(profileObject.last_update, Date.now() || 0);

  if (
    !options.cacheOnly &&
    ((Date.now() - lastCachedSave > 190 * 1000 && Date.now() - lastCachedSave < 300 * 1000) ||
      Date.now() - profileObject.last_update >= 300 * 1000)
  ) {
    try {
      profileObject.last_update = Date.now();
      response = await retry(
        async () => {
          return await hypixel.get("v2/skyblock/profiles", { params });
        },
        { retries: 2 }
      );

      const { data } = response;

      if (!data.success) {
        throw new Error("Request to Hypixel API failed. Please try again!");
      }

      if (data.profiles == null) {
        throw new Error("Player has no SkyBlock profiles.");
      }

      allSkyBlockProfiles = data.profiles;
    } catch (e) {
      if (e?.response?.data?.cause != undefined) {
        throw new Error(`Hypixel API Error: ${e.response.data.cause}.`);
      }

      throw e;
    }
  }

  if (allSkyBlockProfiles.length == 0) {
    throw new Error("Player has no SkyBlock profiles.");
  }

  for (const profile of allSkyBlockProfiles) {
    profile.uuid = paramPlayer;
  }

  let skyBlockProfiles = [];

  if (paramProfile) {
    if (paramProfile.length == 36) {
      skyBlockProfiles = allSkyBlockProfiles.filter((a) => a.profile_id.toLowerCase() == paramProfile);
    } else {
      skyBlockProfiles = allSkyBlockProfiles.filter((a) => a.cute_name.toLowerCase() == paramProfile);
    }
  }

  if (skyBlockProfiles.length == 0) {
    skyBlockProfiles = allSkyBlockProfiles;
  }

  const profiles = [];

  for (const profile of skyBlockProfiles) {
    let memberCount = 0;

    for (let i = 0; i < Object.keys(profile.members).length; i++) {
      memberCount++;
    }

    if (memberCount == 0) {
      if (paramProfile) {
        throw new Error("Uh oh, this SkyBlock profile has no players.");
      }

      continue;
    }

    profiles.push(profile);
  }

  if (profiles.length == 0) {
    throw new Error("No data returned by Hypixel API, please try again!");
  }

  let profile;

  const storeProfiles = {};

  for (const _profile of allSkyBlockProfiles) {
    const userProfile = _profile.members[paramPlayer];

    if (!userProfile) {
      continue;
    }

    if (response && response.request.fromCache !== true) {
      const insertCache = {
        last_update: new Date(),
        members: _profile.members,
      };

      if ("banking" in _profile) {
        insertCache.banking = _profile.banking;
      }

      if ("community_upgrades" in _profile) {
        insertCache.community_upgrades = _profile.community_upgrades;
      }

      db.collection("profileCache")
        .updateOne({ profile_id: _profile.profile_id }, { $set: insertCache }, { upsert: true })
        .catch(console.error);
    }

    storeProfiles[_profile.profile_id] = {
      profile_id: _profile.profile_id ?? null,
      cute_name: _profile.cute_name ?? "Unknown",
      game_mode: _profile.game_mode ?? "normal",
      selected: _profile.selected ?? false,
    };
  }

  for (const _profile of profiles) {
    if (_profile === undefined || _profile === null) {
      return;
    }

    if (
      _profile?.selected ||
      _profile.profile_id.toLowerCase() == paramProfile ||
      _profile.cute_name.toLowerCase() == paramProfile
    ) {
      profile = _profile;
    }
  }

  if (!profile) {
    profile = profiles[0];

    if (!profile) {
      throw new Error("Couldn't find any Skyblock profile that belongs to this player.");
    }
  }

  const userProfile = profile.members[paramPlayer];

  if (profileObject && "current_area" in profileObject) {
    userProfile.current_area = profileObject.current_area;
  }

  userProfile.current_area_updated = true;

  if (response && response.request.fromCache !== true) {
    const apisEnabled =
      "inv_contents" in userProfile &&
      Object.keys(userProfile).filter((a) => a.startsWith("experience_skill_")).length > 0 &&
      "collection" in userProfile;

    const insertProfileStore = {
      last_update: new Date(),
      apis: apisEnabled,
      profiles: storeProfiles,
    };

    try {
      const statusResponse = await hypixel.get("status", {
        params: { uuid: paramPlayer, key: credentials.hypixel_api_key },
      });

      const areaData = statusResponse.data.session;

      if (areaData.online && areaData.gameType == "SKYBLOCK") {
        const areaName = constants.AREA_NAMES[areaData.mode] || helper.titleCase(areaData.mode.replaceAll("_", " "));

        userProfile.current_area = areaName;
        insertProfileStore.current_area = areaName;
      }
    } catch (e) {
      console.error(e);
    }

    // updateLeaderboardPositions(db, paramPlayer, allSkyBlockProfiles).catch(console.error);

    db.collection("profileStore")
      .updateOne({ uuid: sanitize(paramPlayer) }, { $set: insertProfileStore }, { upsert: true })
      .catch(console.error);
  }

  console.debug(`${options.debugId}: getProfile returned. (${Date.now() - timeStarted}ms)`);
  return { profile: profile, allProfiles: allSkyBlockProfiles, uuid: paramPlayer };
}

export async function getBingoProfile(
  db,
  paramPlayer,
  options = { cacheOnly: false, debugId: `${helper.getClusterId()}/unknown@getProfile` }
) {
  console.debug(`${options.debugId}: getBingoProfile called.`);
  const timeStarted = Date.now();

  if (paramPlayer.length != 32) {
    try {
      const { uuid } = await helper.resolveUsernameOrUuid(paramPlayer, db);

      paramPlayer = uuid;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  const params = {
    key: credentials.hypixel_api_key,
    uuid: paramPlayer,
  };

  let profileData = (await db.collection("bingoProfilesCache").findOne({ uuid: sanitize(paramPlayer) })) || {
    last_save: 0,
  };

  const lastCachedSave = profileData.last_save ?? 0;
  if (
    (!options.cacheOnly &&
      ((Date.now() - lastCachedSave > 190 * 1000 && Date.now() - lastCachedSave < 300 * 1000) ||
        Date.now() - profileData.last_save >= 300 * 1000)) ||
    lastCachedSave === 0
  ) {
    try {
      const response = await retry(
        async () => {
          return await hypixel.get("skyblock/bingo", { params });
        },
        { retries: 2 }
      );

      const { data } = response;

      if (!data.success) {
        throw new Error("Request to Hypixel API failed. Please try again!");
      }

      profileData = data;
      profileData.last_save = Date.now();

      db.collection("bingoProfilesCache").updateOne(
        { uuid: sanitize(paramPlayer) },
        { $set: profileData },
        { upsert: true }
      );
    } catch (e) {
      if (e?.response?.data?.cause === "No bingo data could be found") {
        return null;
      }

      if (e?.response?.data?.cause != undefined) {
        throw new Error(`Hypixel API Error: ${e.response.data.cause}.`);
      }

      throw e;
    }
  }

  console.debug(`${options.debugId}: getBingoProfile returned. (${Date.now() - timeStarted}ms)`);
  return profileData;
}
