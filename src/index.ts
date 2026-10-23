// Worker entry point. The Workers runtime treats every named export of this module as an
// entrypoint and refuses to start if one is a plain value, so only the handler is exported here.
// The code lives in relay.ts.
import worker from "./relay";

export default worker;
