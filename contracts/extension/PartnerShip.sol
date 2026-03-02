// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/ITypes.sol";

contract PartnerShip is Ownable {
    struct Fee {
        int256 depositFee;
        int256 redeemFee;
    }

    mapping(address => address) private childToParent;
    mapping(address => Fee) private parentToFees;

    event PartnerShipCreated(address indexed parent, address indexed child);
    event PartnerShipFeesUpdated(address indexed parent, int256 depositFee, int256 redeemFee);

    constructor(address _owner) Ownable(_owner) {}

    // Create the relationship between a parent and children
    function createPartnerShip(address[] calldata _children, address _parent) external onlyOwner {
        for (uint256 i = 0; i < _children.length; i++) {
            address child = _children[i];
            require(child != address(0), "PartnerShip: child is zero address");
            childToParent[child] = _parent;
            emit PartnerShipCreated(_parent, child);
        }
    }

    // Update the fees of the parent
    function updatePartnerShipFees(address _parent, int256 _depositFee, int256 _redeemFee) external onlyOwner {
        require(_parent != address(0), "PartnerShip: parent is zero address");
        parentToFees[_parent] = Fee(_depositFee, _redeemFee);
        emit PartnerShipFeesUpdated(_parent, _depositFee, _redeemFee);
    }

    // Get the parent of the child
    function getParent(address _child) external view returns (address _parent) {
        _parent = childToParent[_child];
    }

    // Get the deposit and redeem fees of the parent
    function getParentFees(address _parent) external view returns (int256 _depositFee, int256 _redeemFee) {
        Fee memory fees = parentToFees[_parent];
        _depositFee = fees.depositFee;
        _redeemFee = fees.redeemFee;
    }

    // Get the fee of the child based on action type
    function getFeeByChildAndAction(address _child, ActionType _action) external view returns (int256 _fee) {
        Fee memory fees = parentToFees[childToParent[_child]];
        _fee = (_action == ActionType.DEPOSIT) ? fees.depositFee : fees.redeemFee;
    }

    // Check if there is a relationship between the child and parent
    function isChildHasParent(address _child) external view returns (bool) {
        return childToParent[_child] != address(0);
    }
}
