const tf = require("@tensorflow/tfjs-node");
const fs = require("fs");
const JSON5 = require("json5");
const path = require("path");

function getFeedByAccountIdQuery(accountId, limit = 10, offset = 0) {
  const whereClause = accountId
    ? `where: { account_id: { _eq: "${accountId}" } }`
    : "";
  const indexerQuery = `
      query GetFeedByAccountId {
          dataplatform_near_social_feed_posts(order_by: { block_height: desc }, limit: ${limit}, offset: ${offset} ${whereClause}) {
              id
              account_id
              block_timestamp
              content
              comments {
                  account_id
                  block_height
              }
              post_likes {
                  account_id
                  block_height
              }
          }
      }
    `;
  return indexerQuery;
}

function getAllPostQuery(limit = 10, offset = 0) {
  const indexerQuery = `
      query GetAllPostQuery {
          dataplatform_near_social_feed_posts(order_by: { block_height: desc }, limit: ${limit}, offset: ${offset}) {
              id
              account_id
              block_timestamp
              content
              comments {
                  account_id
                  block_height
              }
              post_likes {
                  account_id
                  block_height
              }
          }
      }
    `;
  return indexerQuery;
}

async function fetchGraphQL(operationsDoc, operationName, variables) {
  const response = await fetch(
    `https://queryapi-hasura-graphql-24ktefolwq-ew.a.run.app/v1/graphql`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hasura-role": "dataplatform_near",
      },
      body: JSON.stringify({
        query: operationsDoc,
        variables: variables,
        operationName: operationName,
      }),
    }
  );
  const data = await response.json();
  return data;
}

async function getFollowingsById(accountId) {
  const url = "https://api.near.social/index";
  const headers = { "Content-Type": "application/json" };

  const payload = {
    action: "graph",
    key: "follow",
    options: {
      order: "desc",
      accountId: accountId,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(payload),
  });

  if (response.status === 200) {
    const data = await response.json();
    const accountIds = data.map((item) => item.value.accountId);
    return accountIds;
  } else {
    return null;
  }
}

async function fetchAllPosts(limit = 300, offset = 0) {
  try {
    // Get the GraphQL query string for fetching all posts
    const query = getAllPostQuery(limit, offset);

    // Make the GraphQL request
    const response = await fetchGraphQL(query, "GetAllPostQuery", {});

    if (response && response.data) {
      const postsData = response.data.dataplatform_near_social_feed_posts;

      const postEntries = postsData.map((post) => ({
        id: post.id,
        account_id: post.account_id,
        block_timestamp: post.block_timestamp,
        content: post.content,
        comments: post.comments.map((comment) => comment.account_id),
        post_likes: post.post_likes.map((like) => like.account_id),
      }));
      return postEntries;
    } else {
      console.error("Error fetching posts:", response);
      return [];
    }
  } catch (error) {
    console.error("Error fetching posts:", error);
    return [];
  }
}

async function fetchAndExtractPosts(accountId, limit, offset) {
  const operationsDoc = getFeedByAccountIdQuery(accountId, limit, offset);
  const operationName = "GetFeedByAccountId";
  const response = await fetchGraphQL(operationsDoc, operationName, {});

  if (!response) {
    throw new Error(`Error fetching posts: ${response.statusText}`);
  }

  const postsData = response.data.dataplatform_near_social_feed_posts;

  const postEntries = postsData.map((post) => ({
    id: post.id,
    account_id: post.account_id,
    block_timestamp: post.block_timestamp,
    content: post.content,
    comments: post.comments.map((comment) => comment.account_id),
    post_likes: post.post_likes.map((like) => like.account_id),
  }));

  return postEntries;
}

async function fetchFollowings(accountId) {
  const followingsData = await getFollowingsById(accountId);

  return followingsData;
}

async function fetchFollowingsRecursive(
  accountId,
  depth,
  visited = new Set(),
  interested_account_ids = []
) {
  if (depth <= 0 || visited.has(accountId)) {
    return [];
  }

  // Fetch followings of the current account
  const followings = await fetchFollowings(accountId);

  // Add the current account to the visited set
  visited.add(accountId);

  // Recursively fetch followings of followings
  const followingPromises = followings.map(async (following) => {
    if (!visited.has(following)) {
      const followingFollowings = await fetchFollowingsRecursive(
        following,
        depth - 1,
        visited
      );
      return [following, ...followingFollowings];
    }
    return [];
  });

  // Wait for all the promises to resolve
  const followingLists = await Promise.all(followingPromises);

  // Flatten and filter the lists of followings, removing duplicates
  const allFollowings = followingLists.flat().filter((following) => {
    return (
      !visited.has(following) && !interested_account_ids.includes(following)
    );
  });

  return allFollowings;
}

async function fetchPostsRecursive(accountId, depth, limit, offset) {
  if (depth === 0) {
    return [];
  }

  // Fetch and extract posts for the current account
  const postEntries = await fetchAndExtractPosts(accountId, limit, offset);

  // Fetch followings of the current account
  const followings = await fetchFollowings(accountId);

  // Recursively fetch posts from followings of followings
  let posts = [...postEntries];
  for (const following of followings) {
    const followingPosts = await fetchPostsRecursive(
      following,
      depth - 1,
      limit,
      offset
    );
    posts = posts.concat(followingPosts);
  }

  return posts;
}

function mapPostToFeatures(post, followings, targetId) {
  const engagement_score = calculateEngagementScore(post, followings);
  const target_id_like = post.post_likes.includes(targetId) ? 3 : 0;
  const target_id_comment = post.comments.includes(targetId) ? 3 : 0;

  const followerEngagements = followings.map((followerId) => {
    const followerEngagement = calculateEngagementScore(post, [followerId]);
    return followerEngagement;
  });

  const totalFollowerEngagement = followerEngagements.reduce(
    (sum, engagement) => sum + engagement,
    0
  );
  const avg_engagement_followers =
    followings.length > 0 ? totalFollowerEngagement / followings.length : 0;

  return {
    engagement_score,
    avg_engagement_followers,
    target_id_like,
    target_id_comment,
  };
}

function calculateEngagementScore(post, followings) {
  const { comments, post_likes } = post;
  let engagement_score = 0;

  followings.forEach((followerId) => {
    if (post_likes.includes(followerId)) {
      engagement_score += 1; // Increment engagement score for likes
    }

    if (comments.includes(followerId)) {
      engagement_score += 1; // Increment engagement score for comments
    }
  });

  return engagement_score;
}

async function trainModel(account_id) {
  const depth = 2;
  const limit = 10;
  const offset = 0;
  const followings = await fetchFollowings(account_id);
  const posts = (
    await fetchPostsRecursive(account_id, depth, limit, offset)
  ).map((post) => mapPostToFeatures(post, followings, account_id));

  const processedPosts = posts.map((post) => {
    return {
      ...post,
      post_score:
        (post.engagement_score + post.avg_engagement_followers) *
        ((post.target_id_like ?? 1) + (post.target_id_comment ?? 0)),
    };
  });
  console.log(`processedPosts.len ${processedPosts.length}`);

  const features = processedPosts.map((post) => [
    post.engagement_score,
    post.avg_engagement_followers,
    post.target_id_like,
    post.target_id_comment,
  ]);
  const target = processedPosts.map((post) => post.post_score);

  const splitIndex = Math.floor(0.8 * features.length);
  const X_train = features.slice(0, splitIndex);
  const y_train = target.slice(0, splitIndex);
  const X_test = features.slice(splitIndex);
  const y_test = target.slice(splitIndex);

  const model = tf.sequential();
  model.add(
    tf.layers.dense({ units: 64, inputShape: [4], activation: "relu" })
  );
  model.add(tf.layers.dense({ units: 32, activation: "relu" }));
  model.add(tf.layers.dense({ units: 1, activation: "linear" }));

  model.compile({ optimizer: "adam", loss: "meanSquaredError" });

  const xs = tf.tensor2d(X_train);
  const ys = tf.tensor2d(y_train, [y_train.length, 1]);

  await model.fit(xs, ys, {
    epochs: 30,
    shuffle: true,
  });

  const X_testTensor = tf.tensor2d(X_test);
  const y_testTensor = tf.tensor2d(y_test, [y_test.length, 1]);
  const testPredictions = model.predict(X_testTensor).dataSync();
  const testMSE = tf.metrics
    .meanSquaredError(y_testTensor, model.predict(X_testTensor))
    .dataSync()[0];

  return { model, testMSE, testPredictions };
}

async function saveModel(model, modelPath) {
  await model.save(`file://${modelPath}`);
}

async function loadModel(modelPath) {
  const loadedModel = await tf.loadLayersModel(modelPath);
  return loadedModel;
}



function errorHandler(err, req, res, next) {
  // Log the error for debugging purposes (you can customize this part)
  console.info(err);

  // Set the HTTP status code based on the error or default to 500 (Internal Server Error)
  const statusCode = err.statusCode || 500;

  // Send an error response to the client
  res.status(statusCode).json({ error: err.message });
}

module.exports = {
  errorHandler,
  saveModel,
  loadModel,
  getFeedByAccountIdQuery,
  getAllPostQuery,
  fetchGraphQL,
  getFollowingsById,
  fetchAllPosts,
  fetchAndExtractPosts,
  fetchFollowings,
  fetchFollowingsRecursive,
  fetchPostsRecursive,
  mapPostToFeatures,
  calculateEngagementScore,
  trainModel,
};
