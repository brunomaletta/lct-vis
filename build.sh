emcc src/lct.cpp -o web/lct.js \
 -sMODULARIZE \
 -sEXPORT_NAME=createModule \
 -sEXPORTED_FUNCTIONS=_reset,_op_create,_op_link,_op_cut,_op_access,_consume_events,_dump_aux \
 -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString

