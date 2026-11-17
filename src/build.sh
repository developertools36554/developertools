#!/bin/bash
# Build ViralClips v1 (C# WinForms, .NET Framework) with Mono's mcs.
set -e
cd "$(dirname "$0")"
mkdir -p out
mcs -target:winexe -out:out/ViralClips.exe \
    -r:System.Windows.Forms.dll -r:System.Drawing.dll \
    Program.cs
echo "BUILD OK"
ls -la out/
file out/ViralClips.exe
