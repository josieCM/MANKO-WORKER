# PROTOTYPE / SOURCE MATERIAL ONLY — NOT THE DOWNLOADABLE PRODUCT

The code in this `browser-worker/` folder is a local development prototype of the
MANKO Worker runtime. It is **source material** for the future standalone Windows
application. It is:

- NOT the downloadable installer shown in the MANKO "Download Worker" page.
- NOT packaged, signed, or distributed from the Base44 control plane.
- NOT integrated into the Base44 runtime — nothing here runs inside Base44.

The final MANKO Worker will be built and packaged separately as a Windows
application (installer + automatic pairing with the control plane via the
`requestWorkerPairing` / `workerPairingPoll` contract), then attached to a
`WorkerRelease` record so it appears in the Download Worker page.

Treat everything here as reference material for that packaging effort.