const JSON5 = require("json5");

const {
  trainModel,
  loadModel,
  saveModel,
  errorHandler,
} = require("./functions/core");
const express = require("express");
const cors = require('cors')
const app = express();
const port = 3000;



app.use(errorHandler);

app.use(cors());

app.use('/models', express.static('models'));


app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/recommendation/train/:accountId", async (req, res) => {
  const { accountId } = req.params;
  const modelPath = `file://models/${accountId}/model.json`;

  let preLoadedModel;

  console.log(`modelPath ${JSON5.stringify(modelPath)}`);

  try {
    preLoadedModel = await loadModel(modelPath);
  } catch (error) {
    console.log("No preloaded model was found");
    const model = await trainModel(accountId);
    console.log(`Model was loaded`);
    const savePath = `./models/${accountId}/`;

    await saveModel(model.model, savePath);
    preLoadedModel = model.model;
  }

  res.setHeader("Content-Type", "application/json");

  res.send({ "res": "Model was trainded" });
});


app.get('/models/:accountId/model.json', (req, res) => {
  const { accountId } = req.params;

  const modelJsonPath = __dirname + `/models/${accountId}/model.json`;
  res.sendFile(modelJsonPath);
});

app.get('/models/:accountId/weights.bin', (req, res) => {
  const { accountId } = req.params;

  const weightsPath = __dirname + `/models/${accountId}/weights.bin`;
  res.sendFile(weightsPath);
});


app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
