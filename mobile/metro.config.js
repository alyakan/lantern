const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
// Only pure geometry lives outside the mobile project. Its engine is supplied by the mobile bundle.
config.watchFolders = [path.resolve(__dirname, "../shared")];
module.exports = config;
