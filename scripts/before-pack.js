const {Arch}=require('builder-util');
const {check}=require('./check-package');
module.exports=async context=>check(context.packager.projectDir,context.electronPlatformName,Arch[context.arch]);
