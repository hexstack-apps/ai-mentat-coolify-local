#!/usr/bin/env python3
"""
PTY helper — creates a real pseudo-terminal and bridges stdin/stdout.
Used by Electron to get a true TTY without native Node modules.

Usage: python3 pty-helper.py [shell] [args...]
Default: python3 pty-helper.py /bin/zsh -l
"""
import pty, os, sys, select, signal, struct, fcntl, termios

shell = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('SHELL', '/bin/zsh')
args = sys.argv[1:] if len(sys.argv) > 1 else [shell, '-l']

master, slave = pty.openpty()
pid = os.fork()

if pid == 0:
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    os.execvp(args[0], args)

os.close(slave)

# Handle SIGWINCH (terminal resize) — read new size from env or stdin protocol
def handle_winch(sig, frame):
    pass
signal.signal(signal.SIGWINCH, handle_winch)

# Set master fd to non-blocking
import fcntl
flags = fcntl.fcntl(master, fcntl.F_GETFL)
fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)

# Set stdin to non-blocking
flags = fcntl.fcntl(0, fcntl.F_GETFL)
fcntl.fcntl(0, fcntl.F_SETFL, flags | os.O_NONBLOCK)

# Disable stdin buffering
sys.stdout = os.fdopen(sys.stdout.fileno(), 'wb', 0)

try:
    while True:
        rlist, _, _ = select.select([master, 0], [], [], 0.1)
        for fd in rlist:
            if fd == master:
                try:
                    data = os.read(master, 16384)
                    if not data:
                        raise EOFError
                    os.write(1, data)
                except (OSError, EOFError):
                    os._exit(0)
            elif fd == 0:
                try:
                    data = os.read(0, 16384)
                    if not data:
                        raise EOFError
                    os.write(master, data)
                except (OSError, EOFError):
                    os._exit(0)

        # Check if child is still alive
        try:
            rpid, status = os.waitpid(pid, os.WNOHANG)
            if rpid != 0:
                break
        except ChildProcessError:
            break
except KeyboardInterrupt:
    pass
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except:
        pass
    os.close(master)
