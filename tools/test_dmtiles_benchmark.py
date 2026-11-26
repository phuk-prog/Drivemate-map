import unittest
from benchmark_dmtiles_uk import Archive
class EndpointTest(unittest.TestCase):
    def test_origin_not_sink_and_target_not_source(self):
        ar=Archive.__new__(Archive)
        ar.allowed=None
        k="1060_-40"
        nodes={1:[1,53000000,-2000000,[],[]],2:[2,53000020,-2000000,[[1,1,k,100,2200,200]],[]],3:[3,53000100,-2000000,[],[]]}
        ar.tiles={k:{}};ar.load=lambda key:nodes
        self.assertEqual(ar.near((53,-2),True)[1][0],2)
        self.assertEqual(ar.near((53,-2),False)[1][0],1)
        ar.allowed=set()
        self.assertIsNone(ar.near((53,-2),True))
if __name__=="__main__":unittest.main()
