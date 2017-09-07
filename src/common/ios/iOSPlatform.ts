// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as Q from "q";
import * as path from "path";

import {ChildProcess} from "../node/childProcess";
import {CommandExecutor} from "../commandExecutor";
import {GeneralMobilePlatform, MobilePlatformDeps} from "../generalMobilePlatform";
import {IIOSRunOptions} from "../launchArgs";
import {PlistBuddy} from "./plistBuddy";
import {IOSDebugModeManager} from "./iOSDebugModeManager";
import {OutputVerifier, PatternToFailure} from "../outputVerifier";
import {ErrorHelper} from "../error/errorHelper";

type TargetType = "device" | "simulator";

export class IOSPlatform extends GeneralMobilePlatform {
    public static DEFAULT_IOS_PROJECT_RELATIVE_PATH = "ios";

    private static deviceString: TargetType = "device";
    private static simulatorString: TargetType = "simulator";

    private plistBuddy = new PlistBuddy();
    private targetType: TargetType = "simulator";
    private iosProjectRoot: string;

    // We should add the common iOS build/run erros we find to this list
    private static RUN_IOS_FAILURE_PATTERNS: PatternToFailure[] = [{
        pattern: "No devices are booted",
        message: ErrorHelper.ERROR_STRINGS.IOSSimulatorNotLaunchable,
    }, {
        pattern: "FBSOpenApplicationErrorDomain",
        message: ErrorHelper.ERROR_STRINGS.IOSSimulatorNotLaunchable,
    }, {
        pattern: "ios-deploy",
        message: ErrorHelper.ERROR_STRINGS.IOSDeployNotFound,
    }];

    private static RUN_IOS_SUCCESS_PATTERNS = ["BUILD SUCCEEDED"];

    constructor(protected runOptions: IIOSRunOptions, platformDeps: MobilePlatformDeps = {}) {
        super(runOptions, platformDeps);

        if (this.runOptions.iosRelativeProjectPath) { // Deprecated option
            this.logger.logMessage("'iosRelativeProjectPath' option is deprecated. Please use 'runArguments' instead");
        }

        this.iosProjectRoot = path.join(this.projectPath, this.runOptions.iosRelativeProjectPath || IOSPlatform.DEFAULT_IOS_PROJECT_RELATIVE_PATH);

        if (this.runOptions.runArguments && this.runOptions.runArguments.length > 0) {
            this.targetType = (this.runOptions.runArguments.indexOf(`--${IOSPlatform.deviceString}`) >= 0) ?
                IOSPlatform.deviceString : IOSPlatform.simulatorString;
            return;
        }

        if (this.runOptions.target && (this.runOptions.target !== IOSPlatform.simulatorString &&
                this.runOptions.target !== IOSPlatform.deviceString)) {

            this.targetType = IOSPlatform.simulatorString;
            return;
        }

        this.targetType = this.runOptions.target || IOSPlatform.simulatorString;
    }

    public runApp(): Q.Promise<void> {
        // Compile, deploy, and launch the app on either a simulator or a device
        const runArguments = this.getRunArgument();

        const runIosSpawn = new CommandExecutor(this.projectPath, this.logger).spawnReactCommand("run-ios", runArguments);
        return new OutputVerifier(
            () =>
                this.generateSuccessPatterns(),
            () =>
                Q(IOSPlatform.RUN_IOS_FAILURE_PATTERNS)).process(runIosSpawn);
    }

    public enableJSDebuggingMode(): Q.Promise<void> {
        // Configure the app for debugging
        if (this.targetType === IOSPlatform.deviceString) {
            // Note that currently we cannot automatically switch the device into debug mode.
            this.logger.logMessage("Application is running on a device, please shake device and select 'Debug in Chrome' to enable debugging.");
            return Q.resolve<void>(void 0);
        }

        const iosDebugModeManager = new IOSDebugModeManager(this.iosProjectRoot);

        // Wait until the configuration file exists, and check to see if debugging is enabled
        return Q.all<boolean | string>([
            iosDebugModeManager.getSimulatorRemoteDebuggingSetting(),
            this.getBundleId(),
        ])
            .spread((debugModeEnabled: boolean, bundleId: string) => {
                if (debugModeEnabled) {
                    return Q.resolve(void 0);
                }

                // Debugging must still be enabled
                // We enable debugging by writing to a plist file that backs a NSUserDefaults object,
                // but that file is written to by the app on occasion. To avoid races, we shut the app
                // down before writing to the file.
                const childProcess = new ChildProcess();

                return childProcess.execToString("xcrun simctl spawn booted launchctl list")
                    .then((output: string) => {
                        // Try to find an entry that looks like UIKitApplication:com.example.myApp[0x4f37]
                        const regex = new RegExp(`(\\S+${bundleId}\\S+)`);
                        const match = regex.exec(output);

                        // If we don't find a match, the app must not be running and so we do not need to close it
                        return match ? childProcess.exec(`xcrun simctl spawn booted launchctl stop ${match[1]}`) : null;
                    })
                    .then(() => {
                        // Write to the settings file while the app is not running to avoid races
                        return iosDebugModeManager.setSimulatorRemoteDebuggingSetting(/*enable=*/ true);
                    })
                    .then(() => {
                        // Relaunch the app
                        return this.runApp();
                    });
            });
    }

    public prewarmBundleCache(): Q.Promise<void> {
        return this.packager.prewarmBundleCache("ios");
    }

    public getRunArgument(): string[] {
        let runArguments: string[] = [];

        if (this.runOptions.runArguments && this.runOptions.runArguments.length > 0) {
            return this.runOptions.runArguments;
        }

        if (this.runOptions.target) {
            if (this.runOptions.target === IOSPlatform.deviceString ||
                this.runOptions.target === IOSPlatform.simulatorString) {

                runArguments.push(`--${this.runOptions.target}`);
            } else {
                runArguments.push("--simulator", `${this.runOptions.target}`);
            }
        }

        if (this.runOptions.iosRelativeProjectPath) {
            runArguments.push("--project-path", this.runOptions.iosRelativeProjectPath);
        }

        // provide any defined scheme
        if (this.runOptions.scheme) {
            runArguments.push("--scheme", this.runOptions.scheme);
        }

        return runArguments;
    }

    private generateSuccessPatterns(): Q.Promise<string[]> {
        return this.targetType === IOSPlatform.deviceString ?
            Q(IOSPlatform.RUN_IOS_SUCCESS_PATTERNS.concat("INSTALLATION SUCCEEDED")) :
            this.getBundleId()
                .then(bundleId => IOSPlatform.RUN_IOS_SUCCESS_PATTERNS
                    .concat([`Launching ${bundleId}\n${bundleId}: `]));
    }

    private getBundleId(): Q.Promise<string> {
        return this.plistBuddy.getBundleId(this.iosProjectRoot);
    }
}
