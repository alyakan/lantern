const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
// Only pure geometry lives outside the mobile project. Its engine is supplied by the mobile bundle.
config.watchFolders = [path.resolve(__dirname, "../shared")];
// Babel injects runtime helpers into shared files too; those must resolve from the mobile-only install.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
module.exports = config;
