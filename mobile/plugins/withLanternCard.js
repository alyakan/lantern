// Draws the lock-screen card in plain SwiftUI (mobile/native) instead of through expo-widgets' JavaScript layout, which fails
// to a blank card with no error and can't be looked at without a phone.
//
// expo-widgets keeps its widget's Swift in its own package (ios/Widgets) and builds it as a pod, so this puts two files there
// before `expo prebuild` installs the pods: LanternCard.swift (the card; it knows nothing of ActivityKit and is drawn to a
// picture by native/preview/render.sh) and WidgetLiveActivity.swift (expo-widgets' own, with one branch for the card named
// "LanternChat"). The second must be made again from the package's own file whenever expo-widgets changes, so another
// version stops the build here instead of mixing the two.
const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

const EXPO_WIDGETS_VERSION = "58.0.23";
const FILES = ["LanternCard.swift", "WidgetLiveActivity.swift"];

function install(projectRoot) {
  const pkg = path.dirname(require.resolve("expo-widgets/package.json", { paths: [projectRoot] }));
  const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
  if (version !== EXPO_WIDGETS_VERSION) {
    throw new Error(
      `withLanternCard: expo-widgets is ${version}, and mobile/native/WidgetLiveActivity.swift was made from ${EXPO_WIDGETS_VERSION}'s own. ` +
        `Make it again from node_modules/expo-widgets/ios/Widgets/WidgetLiveActivity.swift (keep the "LanternChat" branches), then set EXPO_WIDGETS_VERSION in plugins/withLanternCard.js.`,
    );
  }
  const target = path.join(pkg, "ios", "Widgets");
  for (const name of FILES) fs.copyFileSync(path.join(projectRoot, "native", name), path.join(target, name));
}

const withLanternCard = (config) =>
  withDangerousMod(config, [
    "ios",
    (c) => {
      install(c.modRequest.projectRoot);
      return c;
    },
  ]);

module.exports = withLanternCard;
module.exports.install = install;
module.exports.EXPO_WIDGETS_VERSION = EXPO_WIDGETS_VERSION;
module.exports.FILES = FILES;
