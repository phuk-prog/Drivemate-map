#!/usr/bin/env python3
"""Reject a running Valhalla HTTP backend that cannot answer five UK car routes.

The UK Release graph passed native engine tests at build time; this exercises
the *actual HTTP service* after deployment and secure gateway configuration.
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

from probe_valhalla_graph import SAMPLES, check_response, request


def verify_http(endpoint, opener=urllib.request.urlopen, samples=SAMPLES):
    address=urllib.parse.urlsplit(endpoint)
    if address.scheme not in ("http", "https") or not address.netloc or \
            address.username or address.password or address.query or address.fragment:
        raise ValueError("Route endpoint must be a direct HTTP(S) URL without credentials")
    if address.path not in ("/route", "/route/"):
        raise ValueError("Route endpoint must end in /route")
    if address.scheme != "https" and address.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Unencrypted routing requests are only allowed to loopback")
    results=[]
    for name,start,end in samples:
        payload=request(start,end).encode("utf-8")
        query=urllib.request.Request(endpoint,data=payload,
                      headers={"Content-Type":"application/json",
                               "User-Agent":"DriveMate-UK-engineering-smoke/1"},
                      method="POST")
        try:
            with opener(query,timeout=45) as response:
                body=response.read(4_000_001)
            if len(body)>4_000_000:
                raise ValueError("Oversized routing service response")
            route=check_response(body.decode("utf-8"))
            results.append({"name":name,"passed":True,**route})
        except (OSError,UnicodeError,ValueError,urllib.error.HTTPError) as problem:
            results.append({"name":name,"passed":False,"reason":str(problem)[:220]})
    return {"route_endpoint":endpoint,"road_validated":False,"samples":results,
            "passed":bool(results) and all(x["passed"] for x in results)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint",default="http://127.0.0.1:8002/route")
    args=parser.parse_args()
    report=verify_http(args.endpoint)
    for item in report["samples"]:
        print(("PASS " if item["passed"] else "FAIL ")+item["name"]+
              (": "+item.get("reason","") if not item["passed"] else ""))
    if not report["passed"]:
        print("FAIL: routing backend is not ready for DriveMate",file=sys.stderr)
        return 2
    print("PASS: five real UK HTTP routes and manoeuvres. NOT ROAD VALIDATED.")
    return 0


if __name__=="__main__":
    sys.exit(main())
