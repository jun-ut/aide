@echo off
REM Windows 用の shim。POSIX 側は ~/.local/bin/agent への symlink で足りるが、
REM Windows は shebang を見ないので .cmd が要る。
REM このディレクトリを PATH に足すか、どこか PATH の通った場所へコピーする。
REM %~dp0 は末尾に \ が付くので "%~dp0agent" で bin/agent を指す。
node "%~dp0agent" %*
