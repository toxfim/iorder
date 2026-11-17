-- Integration tests truncate tables, so they must never share a database with dev data.
CREATE DATABASE iorder_test OWNER iorder;
