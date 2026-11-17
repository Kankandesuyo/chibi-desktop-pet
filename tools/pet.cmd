@echo off
rem Command line for the desktop pet: pet <message> / pet /status / pet sessions ...  (needs Node.js)
node "%~dp0pet-cli.cjs" %*
